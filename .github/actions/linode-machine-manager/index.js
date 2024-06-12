const core = require('@actions/core');
const { execSync } = require('child_process');
const { setToken, createLinode, deleteLinode, listLinodes } = require('@linode/api-v4');
const axios = require('axios');
const util = require('util');
const sleep = util.promisify(setTimeout);

// Set the Linode API token
const linodeToken = core.getInput('linode_token');
setToken(linodeToken);

async function waitForSSH(ip, rootPassword, retries = 10, delay = 30000) {
  for (let i = 0; i < retries; i++) {
    try {
      execSync(`sshpass -p '${rootPassword}' ssh -o StrictHostKeyChecking=no root@${ip} 'echo SSH is ready'`, { stdio: 'inherit' });
      return true;
    } catch (error) {
      console.log(`SSH not ready yet. Retrying in ${delay / 1000} seconds...`);
      await sleep(delay);
    }
  }
  throw new Error(`Unable to connect to ${ip} after ${retries} attempts.`);
}

async function unregisterRunner(repoOwner, repoName, githubToken, runnerLabel) {
  const runners = await axios.get(
    `https://api.github.com/repos/${repoOwner}/${repoName}/actions/runners`,
    {
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: 'application/vnd.github.v3+json'
      }
    }
  );

  const runner = runners.data.runners.find(r => r.labels.some(l => l.name === runnerLabel));

  if (runner) {
    await axios.delete(
      `https://api.github.com/repos/${repoOwner}/${repoName}/actions/runners/${runner.id}`,
      {
        headers: {
          Authorization: `Bearer ${githubToken}`,
          Accept: 'application/vnd.github.v3+json'
        }
      }
    );
  }
}

async function run() {
  let linodeId = null;
  try {
    const githubToken = core.getInput('github_token');
    const action = core.getInput('action');
    const machineId = core.getInput('machine_id');
    const searchPhrase = core.getInput('search_phrase');
    const baseLabel = core.getInput('runner_label') || 'self-hosted';
    const rootPassword = core.getInput('root_password');
    const machineType = core.getInput('machine_type');
    const image = core.getInput('image');
    const tags = core.getInput('tags') ? core.getInput('tags').split(',').map(tag => tag.trim()) : [];

    const repoFullName = process.env.GITHUB_REPOSITORY;
    const [repoOwner, repoName] = repoFullName.split('/');

    if (action === 'create') {
      const linode = await createLinode({
        region: 'us-east',
        type: machineType,
        image: image,
        root_pass: rootPassword,
        tags: tags
      });

      linodeId = linode.id;
      const { ipv4 } = linode;
      core.setOutput('machine_id', linodeId);
      core.setOutput('machine_ip', ipv4);

      // Wait for the Linode instance to be ready for SSH connections
      await waitForSSH(ipv4, rootPassword);

      const registrationTokenResponse = await axios.post(
        `https://api.github.com/repos/${repoOwner}/${repoName}/actions/runners/registration-token`,
        {},
        {
          headers: {
            Authorization: `Bearer ${githubToken}`,
            Accept: 'application/vnd.github.v3+json'
          }
        }
      );

      const registrationToken = registrationTokenResponse.data.token;
      const runnerScript = `
        export RUNNER_ALLOW_RUNASROOT="1"
        apt-get update
        apt-get install -y libssl-dev
        mkdir actions-runner && cd actions-runner
        curl -o actions-runner-linux-x64-2.317.0.tar.gz -L https://github.com/actions/runner/releases/download/v2.317.0/actions-runner-linux-x64-2.317.0.tar.gz
        tar xzf ./actions-runner-linux-x64-2.317.0.tar.gz
        ./config.sh --url https://github.com/${repoOwner}/${repoName} --token ${registrationToken} --labels ${baseLabel}
        ./run.sh &
      `;

      try {
        execSync(`sshpass -p '${rootPassword}' ssh -o StrictHostKeyChecking=no root@${ipv4} '${runnerScript}'`, { stdio: 'inherit' });
      } catch (error) {
        console.error(`Runner setup failed: ${error.message}`);
        throw error;
      }

      core.setOutput('runner_label', baseLabel);

    } else if (action === 'destroy') {
      if (machineId) {
        await unregisterRunner(repoOwner, repoName, githubToken, baseLabel);
        await deleteLinode(machineId);
        core.info(`Linode machine ${machineId} destroyed successfully.`);
      } else if (searchPhrase) {
        const instances = await listLinodes();
        const matchingInstances = instances.data.filter(instance =>
          instance.label.includes(searchPhrase) ||
          instance.tags.includes(searchPhrase)
        );

        if (matchingInstances.length === 1) {
          const foundMachineId = matchingInstances[0].id;
          await unregisterRunner(repoOwner, repoName, githubToken, baseLabel);
          await deleteLinode(foundMachineId);
          core.info(`Linode machine ${foundMachineId} destroyed successfully.`);
        } else if (matchingInstances.length === 0) {
          throw new Error(`No Linode instances found matching the search phrase: ${searchPhrase}`);
        } else {
          throw new Error(`Multiple Linode instances found matching the search phrase: ${searchPhrase}`);
        }
      } else {
        throw new Error('Either machine_id or search_phrase must be provided for destruction');
      }
    } else {
      throw new Error('Invalid action. Use "create" or "destroy".');
    }
  } catch (error) {
    core.setFailed(error.message);
    if (linodeId) {
      try {
        await unregisterRunner(repoOwner, repoName, githubToken, baseLabel);
        await deleteLinode(linodeId);
        core.info(`Linode machine ${linodeId} destroyed due to error.`);
      } catch (cleanupError) {
        core.error(`Failed to destroy Linode machine ${linodeId}: ${cleanupError.message}`);
      }
    }
  }
}

run();
