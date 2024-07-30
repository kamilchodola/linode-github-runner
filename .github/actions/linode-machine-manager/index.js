const core = require('@actions/core');
const { execSync } = require('child_process');
const { setToken, getLinodes, createLinode, deleteLinode } = require('@linode/api-v4');
const axios = require('axios');
const util = require('util');
const sleep = util.promisify(setTimeout);

const linodeToken = core.getInput('linode_token');
setToken(linodeToken);

async function waitForSSH(ip, rootPassword, retries = 10, delay = 30000, timeout = 30) {
  for (let i = 0; i < retries; i++) {
    try {
      core.info(`Attempting SSH connection to ${ip}, attempt ${i + 1} of ${retries}`);
      execSync(`sshpass -p '${rootPassword}' ssh -o StrictHostKeyChecking=no -o ConnectTimeout=${timeout} root@${ip} 'echo SSH is ready'`, { stdio: 'inherit' });
      return true;
    } catch (error) {
      core.info(`SSH not ready yet. Retrying in ${delay / 1000} seconds...`);
      await sleep(delay);
    }
  }
  throw new Error(`Unable to connect to ${ip} after ${retries} attempts.`);
}

async function unregisterRunner(repoOwner, repoName, githubToken, runnerLabel) {
  try {
    core.info(`Fetching runners for repo ${repoOwner}/${repoName}`);
    const runnersResponse = await axios.get(
      `https://api.github.com/repos/${repoOwner}/${repoName}/actions/runners`,
      {
        headers: {
          Authorization: `Bearer ${githubToken}`,
          Accept: 'application/vnd.github.v3+json'
        }
      }
    );

    core.info(`Runners response data: ${JSON.stringify(runnersResponse.data, null, 2)}`);

    const runner = runnersResponse.data.runners.find(r => r.labels.some(l => l.name === runnerLabel));
    if (runner) {
      core.info(`Found runner with label ${runnerLabel}, unregistering...`);
      const unregisterResponse = await axios.delete(
        `https://api.github.com/repos/${repoOwner}/${repoName}/actions/runners/${runner.id}`,
        {
          headers: {
            Authorization: `Bearer ${githubToken}`,
            Accept: 'application/vnd.github.v3+json'
          }
        }
      );
      core.info(`Unregister request sent to: https://api.github.com/repos/${repoOwner}/${repoName}/actions/runners/${runner.id}`);
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

async function deleteLinodeInstance(linodeId) {
  try {
    await deleteLinode(linodeId);
    core.info(`Linode machine ${linodeId} destroyed successfully.`);
  } catch (error) {
    core.error(`Failed to destroy Linode machine ${linodeId}: ${error.message}`);
    throw error;
  }
}

async function run() {
  let linodeId = null;
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
  
  try {
    if (!repoOwner || !repoName) {
      throw new Error('Both organization and repo_name inputs are required.');
    }

    if (action === 'create') {
      const registrationTokenUrl = `https://api.github.com/repos/${repoOwner}/${repoName}/actions/runners/registration-token`;

      core.info('Requesting GitHub registration token...');
      core.info(`GitHub registration token request sent to: ${registrationTokenUrl}`);
      let registrationTokenResponse;
      const curlCommand = `curl -X POST ${registrationTokenUrl} \
        -H "Authorization: Bearer ${githubToken}" \
        -H "Accept: application/vnd.github+json" \
        -H "X-GitHub-Api-Version: 2022-11-28"`;
      
      try {
        const result = execSync(curlCommand, { encoding: 'utf-8' });
        const registrationTokenResponse = JSON.parse(result);
        const token = registrationTokenResponse.token;

        if (token) {
          print("Token correctly received")
        }
      } 
      except requests.exceptions.RequestException as error:
        print(f"Failed to get GitHub registration token: {error}")
        if error.stderr:
          try:
            response_data = json.loads(error.stderr)
          except json.JSONDecodeError:
            response_data = error.stderr
          print(f"Response status: {error.returncode} - {response_data}")
        raise
      
      const registrationToken = registrationTokenResponse.data.token;
      core.setSecret(registrationToken);
      core.info('GitHub registration token received.');

      core.info('Creating new Linode instance...');
      const linode = await createLinode({
        region: 'us-east',
        type: machineType,
        image: image,
        root_pass: rootPassword,
        label: baseLabel,
        tags: tags
      });

      linodeId = linode.id;
      const { ipv4 } = linode; 
      core.setSecret(linodeId);
      core.setOutput('machine_id', linodeId);
      core.setSecret(ipv4);
      core.setOutput('machine_ip', ipv4);
      // core.info(`Linode instance created with ID ${linodeId} and IP ${ipv4}`);

      // Wait for the Linode instance to be ready for SSH connections
      await waitForSSH(ipv4, rootPassword);

      const runnerScript = `
        export RUNNER_ALLOW_RUNASROOT="1"
        apt-get update
        apt-get install -y libssl-dev
        mkdir actions-runner && cd actions-runner
        curl -o actions-runner-linux-x64-2.317.0.tar.gz -L https://github.com/actions/runner/releases/download/v2.317.0/actions-runner-linux-x64-2.317.0.tar.gz
        tar xzf ./actions-runner-linux-x64-2.317.0.tar.gz
        ./config.sh --url https://github.com/${repoOwner}/${repoName} --token ${registrationToken} --labels ${baseLabel} --name ${baseLabel}
        nohup ./run.sh > runner.log 2>&1 &
      `;

      core.info('Setting up GitHub runner...');
      try {
        execSync(`sshpass -p '${rootPassword}' ssh -o StrictHostKeyChecking=no root@${ipv4} '${runnerScript}'`, { stdio: 'inherit' });
        core.info('GitHub runner setup completed successfully.');
      } catch (error) {
        core.error(`Runner setup failed: ${error.message}`);
        throw error;
      }

      core.setOutput('runner_label', baseLabel);

    } else if (action === 'destroy') {
      let unregisterError = null;
      try {
        if (machineId) {
          core.info(`Unregistering runner for Linode instance with ID ${machineId}...`);
          await unregisterRunner(repoOwner, repoName, githubToken, baseLabel);
        } else if (searchPhrase) {
          core.info(`Searching for Linode instances matching phrase "${searchPhrase}"...`);
          const instances = await getLinodes();
          // core.info(`Found instances: ${JSON.stringify(instances.data, null, 2)}`);
          const matchingInstances = instances.data.filter(instance =>
            instance.label.includes(searchPhrase) ||
            instance.label === searchPhrase ||
            instance.tags.includes(searchPhrase)
          );

          // core.info(`Matching instances: ${JSON.stringify(matchingInstances, null, 2)}`);

          if (matchingInstances.length === 1) {
            // const foundMachineId = matchingInstances[0].id;
            // core.info(`Found single matching instance with ID ${foundMachineId}, unregistering runner...`);
            await unregisterRunner(repoOwner, repoName, githubToken, baseLabel);
          } else if (matchingInstances.length === 0) {
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

      try {
        if (machineId) {
          await deleteLinodeInstance(machineId);
        } else if (searchPhrase) {
          const instances = await getLinodes();
          const matchingInstances = instances.data.filter(instance =>
            instance.label.includes(searchPhrase) ||
            instance.label === searchPhrase ||
            instance.tags.includes(searchPhrase)
          );
          if (matchingInstances.length === 1) {
            const foundMachineId = matchingInstances[0].id;
            await deleteLinodeInstance(foundMachineId);
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
      throw new Error('Invalid action. Use "create" or "destroy".');
    }
  } catch (error) {
    core.setFailed(error.message);
    if (linodeId) {
      try {
        core.info(`Cleaning up Linode instance with ID ${linodeId} due to error...`);
        await unregisterRunner(repoOwner, repoName, githubToken, baseLabel);
        await deleteLinodeInstance(linodeId);
        core.info(`Linode machine ${linodeId} destroyed during cleanup.`);
      } catch (cleanupError) {
        core.error(`Failed to destroy Linode machine ${linodeId} during cleanup: ${cleanupError.message}`);
      }
    }
  }
}

run();
