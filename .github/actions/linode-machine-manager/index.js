const core = require('@actions/core');
const {
    execSync
} = require('child_process');
const {
    setToken,
    getLinodes,
    createLinode,
    deleteLinode
} = require('@linode/api-v4');
const axios = require('axios');
const util = require('util');
const sleep = util.promisify(setTimeout);

const linodeToken = core.getInput('linode_token');
setToken(linodeToken);

async function waitForSSH(ip, rootPassword, retries = 10, delay = 30000, timeout = 30) {
    for (let i = 0; i < retries; i++) {
        try {
            core.info(`Attempting SSH connection to ${ip}, attempt ${i + 1} of ${retries}`);
            execSync(`sshpass -p '${rootPassword}' ssh -o StrictHostKeyChecking=no -o ConnectTimeout=${timeout} root@${ip} 'echo SSH is ready'`, {
                stdio: 'inherit'
            });
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
            `https://api.github.com/repos/${repoOwner}/${repoName}/actions/runners?per_page=100`, {
                headers: {
                    Authorization: `Bearer ${githubToken}`,
                    Accept: 'application/vnd.github.v3+json'
                }
            }
        );

        const runners = runnersResponse.data.runners;
        core.info(`Total runners found: ${runners.length}`);
        runners.forEach(runner => {
            const maskedRunnerName = runner.name.slice(0, -5).padEnd(runner.name.length, '*');
            core.info(`Runner name: ${maskedRunnerName}`);
        });

        const runner = runnersResponse.data.runners.find(r => r.labels.some(l => l.name === runnerLabel));
        if (runner) {
            core.info(`Found runner with label ${runnerLabel}, unregistering...`);
            const unregisterResponse = await axios.delete(
                `https://api.github.com/repos/${repoOwner}/${repoName}/actions/runners/${runner.id}`, {
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

async function deleteFirewall(linodeId) {
    const firewallLabel = `firewall-${linodeId}`;
    try {
        // List all firewalls
        const firewallsResponse = await axios.get('https://api.linode.com/v4/networking/firewalls', {
            headers: {
                Authorization: `Bearer ${linodeToken}`
            }
        });

        const firewalls = firewallsResponse.data.data;
        const firewall = firewalls.find(fw => fw.label === firewallLabel);

        if (firewall) {
            // Delete the firewall
            await axios.delete(`https://api.linode.com/v4/networking/firewalls/${firewall.id}`, {
                headers: {
                    Authorization: `Bearer ${linodeToken}`
                }
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

async function fetchAllLinodeInstances() {
    let allInstances = [];
    let page = 1;
    const pageSize = 100;

    while (true) {
        const instances = await getLinodes({ page, pageSize });
        allInstances = allInstances.concat(instances.data);

        if (instances.data.length < pageSize) {
            break;
        }
        page++;
    }

    return allInstances;
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
    const blockedPortsInput = core.getInput('blocked_ports');
    const blockedPorts = blockedPortsInput ? blockedPortsInput.split(',').map(port => port.trim()) : [];

    const shouldCreateFirewall = blockedPorts.length > 0;

    try {
        if (!repoOwner || !repoName) {
            throw new Error('Both organization and repo_name inputs are required.');
        }

        if (action === 'create') {
            // Request GitHub registration token
            const registrationTokenUrl = `https://api.github.com/repos/${repoOwner}/${repoName}/actions/runners/registration-token`;

            core.info('Requesting GitHub registration token...');
            core.info(`GitHub registration token request sent to: ${registrationTokenUrl}`);
            let token;
            try {
                const registrationTokenResponse = await axios.post(
                    registrationTokenUrl, {}, {
                        headers: {
                            Authorization: `Bearer ${githubToken}`,
                            Accept: 'application/vnd.github.v3+json'
                        }
                    }
                );
                token = registrationTokenResponse.data.token;
                if (token) {
                    core.info('GitHub registration token received.');
                    core.setSecret(token);
                } else {
                    throw new Error('Failed to retrieve GitHub registration token.');
                }
            } catch (error) {
                core.error(`Failed to get GitHub registration token: ${error.message}`);
                if (error.response) {
                    core.error(`Response status: ${error.response.status} - ${error.response.statusText}`);
                }
                throw error;
            }

            core.info('Creating new Linode instance...');
            const linode = await createLinode({
                region: 'us-east', // Adjust region as needed
                type: machineType,
                image: image,
                root_pass: rootPassword,
                label: baseLabel,
                tags: tags
            });

            linodeId = linode.id;
            const {
                ipv4
            } = linode;
            core.setSecret(linodeId.toString());
            core.setOutput('machine_id', linodeId);
            core.setSecret(ipv4[0]);
            core.setOutput('machine_ip', ipv4[0]);
            core.info(`Linode instance created with ID ${linodeId} and IP ${ipv4[0]}`);

            // Wait for the Linode instance to be ready for SSH connections
            await waitForSSH(ipv4[0], rootPassword);

            const runnerScript = `
export RUNNER_ALLOW_RUNASROOT="1"
apt-get update
apt-get install -y libssl-dev
mkdir actions-runner && cd actions-runner
curl -o actions-runner-linux-x64-2.317.0.tar.gz -L https://github.com/actions/runner/releases/download/v2.317.0/actions-runner-linux-x64-2.317.0.tar.gz
tar xzf ./actions-runner-linux-x64-2.317.0.tar.gz
./config.sh --url https://github.com/${repoOwner}/${repoName} --token ${token} --labels ${baseLabel} --name ${baseLabel}
nohup ./run.sh > runner.log 2>&1 &
`;

            core.info('Setting up GitHub runner...');
            try {
                execSync(`sshpass -p '${rootPassword}' ssh -o StrictHostKeyChecking=no root@${ipv4[0]} '${runnerScript}'`, {
                    stdio: 'inherit'
                });
                core.info('GitHub runner setup completed successfully.');
            } catch (error) {
                core.error(`Runner setup failed: ${error.message}`);
                throw error;
            }

            core.setOutput('runner_label', baseLabel);

            if (shouldCreateFirewall) {
                // Build firewall rules to block specified ports
                function isValidPort(port) {
                    const portNumber = parseInt(port, 10);
                    return Number.isInteger(portNumber) && portNumber >= 1 && portNumber <= 65535;
                }

                // Validate ports
                const invalidPorts = blockedPorts.filter(port => !isValidPort(port));
                if (invalidPorts.length > 0) {
                    throw new Error(`Invalid ports specified: ${invalidPorts.join(', ')}`);
                }

                // Ensure ports are strings
                const inboundRules = blockedPorts.map(port => ({
                    action: 'DROP', // Block traffic to specified ports
                    protocol: 'TCP', // Adjust protocol if necessary
                    ports: port.toString(), // Ensure port is a string
                    addresses: {
                        ipv4: ['0.0.0.0/0'],
                        ipv6: ['::/0']
                    }
                }));

                const firewallRules = {
                    inbound_policy: 'ACCEPT', // Allow all inbound traffic by default
                    outbound_policy: 'ACCEPT', // Allow all outbound traffic
                    inbound: inboundRules, // Rules to block specified ports
                    outbound: []
                };

                const firewallLabel = `firewall-${linodeId}`;
                const firewallRequestBody = {
                    label: firewallLabel,
                    rules: firewallRules,
                    devices: {
                        linodes: [linodeId]
                    }
                };

                core.info('Creating firewall to block specified ports...');
                core.debug(`Firewall Request Body: ${JSON.stringify(firewallRequestBody, null, 2)}`);

                try {
                    const firewallResponse = await axios.post('https://api.linode.com/v4/networking/firewalls', firewallRequestBody, {
                        headers: {
                            Authorization: `Bearer ${linodeToken}`,
                            'Content-Type': 'application/json'
                        }
                    });
                    const firewall = firewallResponse.data;
                    core.info(`Firewall ${firewall.id} created and assigned to Linode instance.`);
                } catch (error) {
                    if (error.response && error.response.data) {
                        core.error(`API Response: ${JSON.stringify(error.response.data, null, 2)}`);
                    }
                    core.error(`Failed to create firewall: ${error.message}`);
                    throw error;
                }
            }

        } else if (action === 'destroy-machine') {
            if (machineId) {
                await deleteLinodeInstance(machineId);
            } else if (searchPhrase) {
                const instances = await fetchAllLinodeInstances();
                
                console.log(`Total instances fetched: ${instances.data.length}`);
                // Log masked labels for all instances
                instances.data.forEach(instance => {
                    const maskedLabel = instance.label.slice(0, -5).padEnd(instance.label.length, '*');
                    console.log(`Instance ID: ${instance.id}, Masked label: ${maskedLabel}`);
                });
                
                const matchingInstances = instances.data.filter(instance =>
                    instance.label.includes(searchPhrase) ||
                    instance.label === searchPhrase ||
                    instance.tags.includes(searchPhrase)
                );
                
                if (matchingInstances.length === 1) {
                    const foundMachineId = matchingInstances[0].id;
                    await deleteLinodeInstance(foundMachineId);
                } else if (matchingInstances.length === 0) {
                    throw new Error(`No Linode instances found matching the search phrase: ${searchPhrase}`);
                } else {
                    throw new Error(`Multiple Linode instances found matching the search phrase: ${searchPhrase}`);
                }
            } else {
                throw new Error('Either machine_id or search_phrase must be provided for machine destruction');
            }
        } else if (action === 'destroy-runner') {
            if (machineId || searchPhrase) {
                await unregisterRunner(repoOwner, repoName, githubToken, baseLabel);
            } else {
                throw new Error('Either machine_id or search_phrase must be provided for runner destruction');
            }
        } else if (action === 'destroy') {
            let unregisterError = null;
            try {
                if (machineId) {
                    core.info(`Unregistering runner for Linode instance with ID ${machineId}...`);
                    await unregisterRunner(repoOwner, repoName, githubToken, baseLabel);
                } else if (searchPhrase) {
                    core.info(`Searching for Linode instances matching phrase "${searchPhrase}"...`);
                    const instances = await fetchAllLinodeInstances();
                    const matchingInstances = instances.data.filter(instance =>
                        instance.label.includes(searchPhrase) ||
                        instance.label === searchPhrase ||
                        instance.tags.includes(searchPhrase)
                    );

                    if (matchingInstances.length === 1) {
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
                    const instances = await fetchAllLinodeInstances();
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
            throw new Error('Invalid action. Use "create", "destroy", "destroy-machine", or "destroy-runner".');
        }
    } catch (error) {
        core.setFailed(error.message);
        if (linodeId) {
            try {
                core.info(`Cleaning up Linode instance with ID ${linodeId} due to error...`);
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
