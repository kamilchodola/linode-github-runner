const core = require('@actions/core');
const { execSync } = require('child_process');
const { setToken, getLinodes, createLinode, deleteLinode } = require('@linode/api-v4');
const axios = require('axios');
const util = require('util');
const sleep = util.promisify(setTimeout);

const linodeToken = core.getInput('linode_token');
setToken(linodeToken);

const pollingTime = parseInt(core.getInput('polling_time')) || 20000; // default 20s
const timeout = parseInt(core.getInput('timeout')) || 600000; // default 10m

// Input variables
const githubToken = core.getInput('github_token');
const action = core.getInput('action');
const machineId = core.getInput('machine_id');
const searchPhrase = core.getInput('search_phrase');
const baseLabel = core.getInput('runner_label') || 'self-hosted';
const rootPassword = core.getInput('root_password');
const machineType = core.getInput('machine_type');
const image = core.getInput('image');
const tags = core.getInput('tags') ? core.getInput('tags').split(',').map(tag => tag.trim()) : [];
const repoOwner = core.getInput('organization');
const repoName = core.getInput('repo_name');
const blockedPortsInput = core.getInput('blocked_ports');
const blockedPorts = blockedPortsInput ? blockedPortsInput.split(',').map(port => port.trim()) : [];

const shouldCreateFirewall = blockedPorts.length > 0;

/**
 * Helper Functions
 */

/**
 * Wait for SSH to become available on the Linode instance.
 */
async function waitForSSH(ip, password, retries = 10, delay = 30000, sshTimeout = 30) {
  for (let i = 0; i < retries; i++) {
    try {
      core.info(`Attempting SSH connection to ${ip}, attempt ${i + 1} of ${retries}`);
      execSync(`sshpass -p '${password}' ssh -o StrictHostKeyChecking=no -o ConnectTimeout=${sshTimeout} root@${ip} 'echo SSH is ready'`, { stdio: 'inherit' });
      return true;
    } catch (error) {
      core.info(`SSH not ready yet. Retrying in ${delay / 1000} seconds...`);
      await sleep(delay);
    }
  }
  throw new Error(`Unable to connect to ${ip} after ${retries} attempts.`);
}

/**
 * Unregister a GitHub runner by its label from a given repo.
 */
async function unregisterRunner(owner, repo, token, runnerLabel) {
  try {
    core.info(`Fetching runners for repo ${owner}/${repo}`);
    const runnersResponse = await axios.get(
      `https://api.github.com/repos/${owner}/${repo}/actions/runners?per_page=100`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github.v3+json',
        },
      }
    );

    const runner = runnersResponse.data.runners.find(r => r.labels.some(l => l.name === runnerLabel));
    if (runner) {
      core.info(`Found runner with label ${runnerLabel}, unregistering...`);
      const unregisterUrl = `https://api.github.com/repos/${owner}/${repo}/actions/runners/${runner.id}`;
      const unregisterResponse = await axios.delete(unregisterUrl, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github.v3+json',
        },
      });
      core.info(`Unregister request sent to: ${unregisterUrl}`);
      if (unregisterResponse.status === 204) {
        core.info(`Runner with label ${runnerLabel} unregistered successfully.`);
      } else {
        core.error(`Failed to unregister runner: ${unregisterResponse.status} - ${unregisterResponse.statusText}`);
      }
    } else {
      core.info(`Runner with label ${runnerLabel} not found.`);
    }
  } catch (error) {
    if (error.response && error.response.status === 422) {
      core.error(`Failed to unregister runner: ${error.response.status} - ${error.response.statusText}`);
    } else {
      core.error(`Failed to unregister runner: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Delete firewall by linodeId (synchronous).
 */
async function deleteFirewall(linodeId) {
  const firewallLabel = `firewall-${linodeId}`;
  try {
    const allFirewalls = await getAllFirewalls();
    const firewall = allFirewalls.find(fw => fw.label === firewallLabel);
    if (firewall) {
      await axios.delete(`https://api.linode.com/v4/networking/firewalls/${firewall.id}`, {
        headers: { Authorization: `Bearer ${linodeToken}` },
      });
      core.info(`Firewall ${firewall.id} deleted successfully.`);
    } else {
      core.info(`Firewall with label ${firewallLabel} not found.`);
    }
  } catch (error) {
    core.error(`Failed to delete firewall: ${error.message}`);
    throw error;
  }
}

/**
 * Async "fire-and-forget" methods for deletion
 */
async function deleteFirewallAsync(linodeId) {
  const firewallLabel = `firewall-${linodeId}`;
  try {
    const allFirewalls = await getAllFirewalls();
    const firewall = allFirewalls.find(fw => fw.label === firewallLabel);

    if (firewall) {
      // Fire-and-forget delete request
      axios.delete(`https://api.linode.com/v4/networking/firewalls/${firewall.id}`, {
        headers: {
          Authorization: `Bearer ${linodeToken}`
        }
      });
      core.info(`Async request sent to delete firewall ${firewall.id}.`);
    } else {
      core.info(`Firewall with label ${firewallLabel} not found.`);
    }
  } catch (error) {
    core.error(`Failed to send async delete request for firewall: ${error.message}`);
  }
}

/**
 * Delete a Linode instance and its firewall (synchronous).
 */
async function deleteLinodeInstance(linodeId) {
  try {
    await deleteFirewall(linodeId);
    await deleteLinode(linodeId);
    core.info(`Linode machine ${linodeId} and associated firewall destroyed successfully.`);
  } catch (error) {
    core.error(`Failed to destroy Linode machine ${linodeId} or associated firewall: ${error.message}`);
    throw error;
  }
}

/**
 * Create a Linode with polling to handle rate limits.
 */
async function createLinodeWithPolling(linodeOptions, retries = Math.floor(timeout / pollingTime)) {
  let attempt = 0;
  while (attempt < retries) {
    try {
      const linode = await createLinode(linodeOptions);
      core.info(`Linode instance created successfully with ID ${linode.id}`);
      return linode;
    } catch (error) {
      if (error.response && error.response.status === 429) {
        core.info(`Rate limit hit (429). Retrying in ${pollingTime / 1000} seconds...`);
        attempt += 1;
        if (attempt >= retries) {
          throw new Error(`Exceeded max retries. Unable to create Linode after ${retries} attempts.`);
        }
        await sleep(pollingTime);
      } else {
        throw error;
      }
    }
  }
}

/**
 * Request GitHub registration token for a runner.
 */
async function requestGitHubRegistrationToken(owner, repo, token) {
  const registrationTokenUrl = `https://api.github.com/repos/${owner}/${repo}/actions/runners/registration-token`;
  core.info('Requesting GitHub registration token...');
  core.info(`GitHub registration token request sent to: ${registrationTokenUrl}`);

  const response = await axios.post(registrationTokenUrl, {}, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3+json',
    },
  });
  const regToken = response.data.token;
  if (!regToken) {
    throw new Error('Failed to retrieve GitHub registration token.');
  }
  core.info('GitHub registration token received.');
  core.setSecret(regToken);
  return regToken;
}

/**
 * Setup GitHub runner on the Linode instance via SSH.
 */
function setupGitHubRunner(ip, password, owner, repo, token, label) {
  const runnerScript = `
    export RUNNER_ALLOW_RUNASROOT="1"
    apt-get update
    apt-get install -y libssl-dev
    mkdir actions-runner && cd actions-runner
    curl -o actions-runner-linux-x64-2.317.0.tar.gz -L https://github.com/actions/runner/releases/download/v2.317.0/actions-runner-linux-x64-2.317.0.tar.gz
    tar xzf ./actions-runner-linux-x64-2.317.0.tar.gz
    ./config.sh --url https://github.com/${owner}/${repo} --token ${token} --labels ${label} --name ${label}
    nohup ./run.sh > runner.log 2>&1 &
  `;

  core.info('Setting up GitHub runner...');
  execSync(`sshpass -p '${password}' ssh -o StrictHostKeyChecking=no root@${ip} '${runnerScript}'`, { stdio: 'inherit' });
  core.info('GitHub runner setup completed successfully.');
}

/**
 * Create a firewall for given Linode instance to block specified ports.
 */
async function createFirewallForLinode(linodeId, ports) {
  const firewallLabel = `firewall-${linodeId}`;

  function isValidPort(port) {
    const portNumber = parseInt(port, 10);
    return Number.isInteger(portNumber) && portNumber >= 1 && portNumber <= 65535;
  }

  const invalidPorts = ports.filter(port => !isValidPort(port));
  if (invalidPorts.length > 0) {
    throw new Error(`Invalid ports specified: ${invalidPorts.join(', ')}`);
  }

  const inboundRules = ports.map(port => ({
    action: 'DROP',
    protocol: 'TCP',
    ports: port.toString(),
    addresses: {
      ipv4: ['0.0.0.0/0'],
      ipv6: ['::/0'],
    },
  }));

  const firewallRequestBody = {
    label: firewallLabel,
    rules: {
      inbound_policy: 'ACCEPT',
      outbound_policy: 'ACCEPT',
      inbound: inboundRules,
      outbound: [],
    },
    devices: { linodes: [linodeId] },
  };

  core.info('Creating firewall to block specified ports...');
  core.debug(`Firewall Request Body: ${JSON.stringify(firewallRequestBody, null, 2)}`);

  const firewallResponse = await axios.post(
    'https://api.linode.com/v4/networking/firewalls',
    firewallRequestBody,
    {
      headers: {
        Authorization: `Bearer ${linodeToken}`,
        'Content-Type': 'application/json',
      },
    }
  );
  const firewall = firewallResponse.data;
  core.info(`Firewall ${firewall.id} created and assigned to Linode instance.`);
}

/**
 * Find Linode instances by search phrase.
 */
async function findLinodeByPhrase(phrase) {
  const instances = await getLinodes({ page: 1, page_size: 500 });
  const matches = instances.data.filter(instance =>
    instance.label.includes(phrase) ||
    instance.label === phrase ||
    instance.tags.includes(phrase)
  );
  return matches;
}

/**
 * Delete Linode Instance Asynchronously not to block the thread and to speed up in case it is used as GH runner
 */

async function deleteLinodeInstanceAsync(linodeId) {
  try {
    // Fire-and-forget firewall delete
    deleteFirewallAsync(linodeId);

    // Fire-and-forget Linode delete
    axios.delete(`https://api.linode.com/v4/linode/instances/${linodeId}`, {
      headers: {
        Authorization: `Bearer ${linodeToken}`
      }
    });
    core.info(`Async request sent to delete Linode instance ${linodeId}.`);
  } catch (error) {
    core.error(`Failed to send async delete request for Linode machine: ${error.message}`);
  }
}

/**
 * Get All Firewalls with pagination support
 */

async function getAllFirewalls() {
  let page = 1;
  let allFirewalls = [];
  let hasMore = true;

  while (hasMore) {
    const response = await axios.get(`https://api.linode.com/v4/networking/firewalls?page=${page}&page_size=100`, {
      headers: { Authorization: `Bearer ${linodeToken}` },
    });
    allFirewalls = allFirewalls.concat(response.data.data);
    hasMore = response.data.pages > page;
    page += 1;
  }

  return allFirewalls;
}


/**
 * Main execution logic
 */
async function run() {
  let linodeId = null;

  if (!repoOwner || !repoName) {
    core.setFailed('Both organization and repo_name inputs are required.');
    return;
  }

  try {
    if (action === 'create') {
      // Create a new machine and runner
      const regToken = await requestGitHubRegistrationToken(repoOwner, repoName, githubToken);

      core.info('Creating new Linode instance...');
      const linodeOptions = {
        region: 'us-ord',
        type: machineType,
        image: image,
        root_pass: rootPassword,
        label: baseLabel,
        tags: tags,
      };

      const linode = await createLinodeWithPolling(linodeOptions);
      linodeId = linode.id;
      const { ipv4 } = linode;

      core.setSecret(linodeId.toString());
      core.setOutput('machine_id', linodeId);
      core.setSecret(ipv4[0]);
      core.setOutput('machine_ip', ipv4[0]);

      // Wait for SSH
      await waitForSSH(ipv4[0], rootPassword);

      // Setup runner
      setupGitHubRunner(ipv4[0], rootPassword, repoOwner, repoName, regToken, baseLabel);
      core.setOutput('runner_label', baseLabel);

      // Create firewall if needed
      if (shouldCreateFirewall) {
        await createFirewallForLinode(linodeId, blockedPorts);
      }

    } else if (action === 'destroy-machine' || action === 'destroy-machine-async') {
      // Destroy machine only
      const isAsync = action === 'destroy-machine-async';

      if (machineId) {
        isAsync ? deleteLinodeInstanceAsync(machineId) : await deleteLinodeInstance(machineId);
      } else if (searchPhrase) {
        const matches = await findLinodeByPhrase(searchPhrase);
        if (matches.length === 1) {
          isAsync ? deleteLinodeInstanceAsync(matches[0].id) : await deleteLinodeInstance(matches[0].id);
        } else if (matches.length === 0) {
          throw new Error(`No Linode instances found matching the search phrase: ${searchPhrase}`);
        } else {
          throw new Error(`Multiple Linode instances found matching the search phrase: ${searchPhrase}`);
        }
      } else {
        throw new Error('Either machine_id or search_phrase must be provided for machine destruction');
      }

    } else if (action === 'destroy-runner') {
      // Unregister runner only
      if (machineId || searchPhrase) {
        await unregisterRunner(repoOwner, repoName, githubToken, baseLabel);
      } else {
        throw new Error('Either machine_id or search_phrase must be provided for runner destruction');
      }

    } else if (action === 'destroy' || action === 'destroy-async') {
      // Unregister runner and then destroy machine
      const isAsync = action === 'destroy-async';
      let unregisterError = null;

      // Unregister the runner
      try {
        if (machineId) {
          await unregisterRunner(repoOwner, repoName, githubToken, baseLabel);
        } else if (searchPhrase) {
          const matches = await findLinodeByPhrase(searchPhrase);
          if (matches.length === 1) {
            await unregisterRunner(repoOwner, repoName, githubToken, baseLabel);
          } else if (matches.length === 0) {
            throw new Error(`No Linode instances found matching the search phrase: ${searchPhrase}`);
          } else {
            throw new Error(`Multiple Linode instances found matching the search phrase: ${searchPhrase}`);
          }
        } else {
          throw new Error('Either machine_id or search_phrase must be provided for destruction');
        }
      } catch (error) {
        unregisterError = error;
        core.error(`Failed to unregister runner: ${error.message}`);
      }

      // Destroy machine
      try {
        if (machineId) {
          isAsync ? deleteLinodeInstanceAsync(machineId) : await deleteLinodeInstance(machineId);
        } else if (searchPhrase) {
          const matches = await findLinodeByPhrase(searchPhrase);
          if (matches.length === 1) {
            isAsync ? deleteLinodeInstanceAsync(matches[0].id) : await deleteLinodeInstance(matches[0].id);
          }
        }
      } catch (deleteError) {
        core.error(`Failed to destroy Linode machine: ${deleteError.message}`);
        if (unregisterError) {
          throw new Error(`Failed to unregister runner and destroy Linode. Unregister error: ${unregisterError.message}, Destroy error: ${deleteError.message}`);
        } else {
          throw new Error(`Failed to destroy Linode machine. Destroy error: ${deleteError.message}`);
        }
      }

      if (unregisterError) {
        throw unregisterError;
      }

    } else {
      throw new Error('Invalid action. Use "create", "destroy", "destroy-machine", "destroy-runner", or their async counterparts.');
    }

  } catch (error) {
    core.setFailed(error.message);

    // Cleanup if Linode was created but failed later
    if (linodeId) {
      core.info(`Cleaning up Linode instance with ID ${linodeId} due to error...`);
      try {
        await deleteLinodeInstance(linodeId);
        await unregisterRunner(repoOwner, repoName, githubToken, baseLabel);
        core.info(`Linode machine ${linodeId} destroyed during cleanup.`);
      } catch (cleanupError) {
        core.error(`Failed to destroy Linode machine ${linodeId} during cleanup: ${cleanupError.message}`);
      }
    }
  }
}

run();
