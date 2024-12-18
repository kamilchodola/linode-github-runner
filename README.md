# Linode GitHub Runner

[![GitHub Marketplace](https://img.shields.io/badge/GitHub%20Marketplace-Linode%20GitHub%20Runner-blue.svg?style=flat-square&logo=github)](https://github.com/marketplace)
[![License](https://img.shields.io/github/license/kamilchodola/linode-github-runner?style=flat-square)](./LICENSE)

This GitHub Action helps you dynamically create and manage [Linode](https://www.linode.com) instances as self-hosted GitHub runners. Use it to:

- **Create** a new Linode instance and register it as a GitHub self-hosted runner.
- **Destroy** a Linode instance and unregister the runner when it's no longer needed.
- **Unregister** runners independently from destroying machines, or vice versa.
- **Optionally block ports** using the Linode firewall for enhanced security.
- **Perform actions synchronously or asynchronously** for fire-and-forget resource cleanup.

## Key Features

- **On-Demand Creation:** Set up self-hosted runners in your CI workflows dynamically.
- **Flexible Cleanup:** Destroy machines, unregister runners, or do both at once.
- **Security via Firewalls:** Block specific ports on the Linode instance with an automatically configured firewall.
- **Async Deletion:** Send asynchronous requests to clean up machines/firewalls without waiting for completion.

## Inputs

| Name            | Description                                                                                                                                                                           | Required | Default        |
|-----------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------|----------------|
| `linode_token`  | Linode API token with appropriate permissions to create, delete Linodes, and manage firewalls.                                                                                        | **Yes**  |                |
| `github_token`  | GitHub token with `repo` scope allowing registration and removal of self-hosted runners in the specified repository.                                                                 | **Yes**  |                |
| `action`        | The action to perform: <br>**create**: Create a Linode & runner <br>**destroy**: Unregister runner & destroy Linode <br>**destroy-runner**: Unregister runner only <br>**destroy-machine**: Destroy machine only <br>Async variants: **destroy-async**, **destroy-machine-async** | **Yes**  |                |
| `machine_id`    | The ID of the Linode machine to target for destruction/unregistration. Required if you know the exact machine ID. Used by **destroy**, **destroy-machine**, and their async variants. | No       |                |
| `search_phrase` | A phrase to search by label or tags to find a matching Linode machine if `machine_id` isn't provided. Used for **destroy**, **destroy-machine**, **destroy-runner**, and async variants. If multiple or no machines match, the action fails. | No       |                |
| `runner_label`  | The label for the self-hosted runner. If not provided, defaults to `self-hosted`. This label helps identify the runner when unregistering.                                            | No       | `self-hosted`  |
| `root_password` | The root password for the new Linode machine. **Required when `action` is `create`** to configure SSH and install the runner.                                                          | If create |                |
| `machine_type`  | The Linode plan type (e.g., `g6-standard-2`) for the created machine. **Required when `action` is `create`.**                                                                        | If create |                |
| `image`         | The Linode image to deploy (e.g., `linode/ubuntu20.04`). **Required when `action` is `create`.**                                                                                     | If create |                |
| `tags`          | Comma-separated list of tags for the Linode instance. For example: `ci,runners`.                                                                                                     | No       |                |
| `organization`  | The GitHub organization that owns the repository where the runner should be registered/unregistered. **Always required.**                                                            | **Yes**  |                |
| `repo_name`     | The name of the repository for which the runner is being registered/unregistered. **Always required.**                                                                               | **Yes**  |                |
| `blocked_ports` | Comma-separated list of ports to block using the Linode firewall. If specified, a firewall is created and assigned to the Linode instance.                                             | No       |                |
| `polling_time`  | The interval (in milliseconds) to wait between Linode creation attempts if rate-limited. Default: `20000` (20 seconds).                                                               | No       | 20000          |
| `timeout`       | The maximum time (in milliseconds) to retry creating the Linode machine before giving up. Default: `600000` (10 minutes).                                                            | No       | 600000         |

## Outputs

| Name           | Description                                                   |
|----------------|---------------------------------------------------------------|
| `runner_label` | The label of the GitHub self-hosted runner created.           |
| `machine_id`   | The ID of the created or destroyed Linode machine.            |
| `machine_ip`   | The IP address of the created Linode machine.                 |

## Actions

- **create**:  
  Creates a new Linode instance, installs, and configures it as a GitHub self-hosted runner.

- **destroy**:  
  Unregisters the associated GitHub self-hosted runner and destroys the Linode instance.

- **destroy-machine**:  
  Destroys the Linode instance only, without unregistering any associated runner.

- **destroy-runner**:  
  Unregisters a GitHub self-hosted runner only, without destroying the Linode machine.

- **Async variants** (`destroy-async`, `destroy-machine-async`):  
  Send asynchronous ("fire-and-forget") requests to destroy resources without waiting for completion.

## Example Usage

### 1. Create a New Linode Machine and Register a Runner

```yaml
jobs:
  create-machine:
    runs-on: ubuntu-latest
    steps:
      - name: Create Linode machine and runner
        uses: kamilchodola/linode-github-runner@v1
        with:
          linode_token: ${{ secrets.LINODE_TOKEN }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
          action: 'create'
          root_password: ${{ secrets.ROOT_PASSWORD }}
          machine_type: 'g6-standard-2'
          image: 'linode/ubuntu20.04'
          tags: 'ci,runners'
          organization: 'your-org'
          repo_name: 'your-repo'
          polling_time: 20000
          timeout: 600000
```

### 2. Destroy a Specific Linode Machine and Unregister its Runner

```yaml
jobs:
  destroy-machine:
    runs-on: ubuntu-latest
    steps:
      - name: Destroy Linode machine and associated runner
        uses: kamilchodola/linode-github-runner@v1
        with:
          linode_token: ${{ secrets.LINODE_TOKEN }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
          action: 'destroy'
          machine_id: '12345'
          organization: 'your-org'
          repo_name: 'your-repo'
```

### 3. Destroy a Self-Hosted Runner Only

```yaml
jobs:
  destroy-runner:
    runs-on: ubuntu-latest
    steps:
      - name: Destroy self-hosted runner
        uses: kamilchodola/linode-github-runner@v1
        with:
          linode_token: ${{ secrets.LINODE_TOKEN }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
          action: 'destroy-runner'
          runner_label: 'my-self-hosted-runner'
          organization: 'your-org'
          repo_name: 'your-repo'
```

### 4. Use Search Phrase Instead of Machine ID

If you don't have the machine ID, you can use search_phrase to find a machine by label or tags:

```yaml
jobs:
  destroy-with-search:
    runs-on: ubuntu-latest
    steps:
      - name: Destroy Linode machine by search phrase
        uses: kamilchodola/linode-github-runner@v1
        with:
          linode_token: ${{ secrets.LINODE_TOKEN }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
          action: 'destroy'
          search_phrase: 'ci'  # Matches by label or tag
          organization: 'your-org'
          repo_name: 'your-repo'
```

## Setup and Requirements

- **Linode API Token** (`LINODE_TOKEN`): Must have permissions to create and manage Linode instances and firewalls.
- **GitHub Token** (`GITHUB_TOKEN`): Must have repo scope to register/unregister self-hosted runners.
- **Root Password** (`ROOT_PASSWORD`): Used to configure the Linode instance for SSH and runner setup on creation.

Add these as GitHub Secrets in your repository:
**Settings > Secrets and variables > Actions > New repository secret**

## License
This project is licensed under the MIT License.
