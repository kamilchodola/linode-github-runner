const core = require('@actions/core');
const { execSync } = require('child_process');
const { setToken, createLinode, deleteLinode, listLinodes } = require('@linode/api-v4');
const axios = require('axios');

// Set the Linode API token
const linodeToken = core.getInput('linode_token');
setToken(linodeToken);

async function run() {
  try {
    const githubToken = core.getInput('github_token');
    const action = core.getInput('action');
    const machineId = core.getInput('machine_id');
    const searchPhrase = core.getInput('search_phrase');
    const baseLabel = core.getInput('runner_label') || 'self-hosted';
    const rootPassword = core.getInput('root_password');
    const machineType = core.getInput('machine_type');
    const image = core.getInput('image');

    const repoFullName = process.env.GITHUB_REPOSITORY;
    const [repoOwner, repoName] = repoFullName.split('/');

    if (action === 'create') {
      const linode = await createLinode({
        region: 'us-east',
        type: machineType,
        image: image,
        root_pass: rootPassword
      });

      const { id, ipv4 } = linode;
      core.setOutput('machine_id', id);
      core.setOutput('machine_ip', ipv4);

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
        mkdir actions-runner && cd actions-runner
        curl -o actions-runner-linux-x64-2.284.0.tar.gz -L https://github.com/actions/runner/releases/download/v2.284.0/actions-runner-linux-x64-2.284.0.tar.gz
        tar xzf ./actions-runner-linux-x64-2.284.0.tar.gz
        ./config.sh --url https://github.com/${repoOwner}/${repoName} --token ${registrationToken} --labels ${baseLabel}
        ./svc.sh install
        ./svc.sh start
      `;

      execSync(`ssh -o StrictHostKeyChecking=no root@${ipv4} '${runnerScript}'`);

      core.setOutput('runner_label', baseLabel);

    } else if (action === 'destroy') {
      if (machineId) {
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
  }
}

run();
