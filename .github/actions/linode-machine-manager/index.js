const core = require('@actions/core');
const { LinodeClient } = require('@linode/api-v4');
const { execSync } = require('child_process');
const axios = require('axios');

async function run() {
  try {
    const linodeToken = core.getInput('linode_token');
    const githubToken = core.getInput('github_token');
    const action = core.getInput('action');
    const machineId = core.getInput('machine_id');
    const searchPhrase = core.getInput('search_phrase');
    const baseLabel = core.getInput('runner_label') || 'self-hosted';
    const linodeClient = new LinodeClient(linodeToken);

    if (action === 'create') {
      const linode = await linodeClient.linodeInstances.create({
        region: 'us-east',
        type: 'g6-standard-1',
        image: 'linode/ubuntu22.04',
        root_pass: 'your-secure-password'
      });

      const { id, ipv4 } = linode;
      core.setOutput('machine_id', id);
      core.setOutput('machine_ip', ipv4);

      const registrationToken = await axios.post(`https://api.github.com/repos/owner/repo/actions/runners/registration-token`, {}, {
        headers: {
          Authorization: `Bearer ${githubToken}`,
          Accept: 'application/vnd.github.v3+json'
        }
      });

      const runnerScript = `
        mkdir actions-runner && cd actions-runner
        curl -o actions-runner-linux-x64-2.284.0.tar.gz -L https://github.com/actions/runner/releases/download/v2.284.0/actions-runner-linux-x64-2.284.0.tar.gz
        tar xzf ./actions-runner-linux-x64-2.284.0.tar.gz
        ./config.sh --url https://github.com/owner/repo --token ${registrationToken.data.token} --labels ${finalLabel}
        ./svc.sh install
        ./svc.sh start
      `;

      execSync(`ssh -o StrictHostKeyChecking=no root@${ipv4} '${runnerScript}'`);

      core.setOutput('runner_label', finalLabel);

    } else if (action === 'destroy') {
      if (machineId) {
        await linodeClient.linodeInstances.delete(machineId);
        core.info(`Linode machine ${machineId} destroyed successfully.`);
      } else if (searchPhrase) {
        const instances = await linodeClient.linodeInstances.list();
        const matchingInstances = instances.filter(instance => 
          instance.label.includes(searchPhrase) || 
          instance.tags.includes(searchPhrase)
        );

        if (matchingInstances.length === 1) {
          const foundMachineId = matchingInstances[0].id;
          await linodeClient.linodeInstances.delete(foundMachineId);
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
