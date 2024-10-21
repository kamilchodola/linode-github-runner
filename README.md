
# Linode Github Runner

This GitHub Action allows you to create and manage Linode machines and set up GitHub self-hosted runners. The action can create new Linode instances, configure them as self-hosted runners, and destroy instances or runners.

## Inputs

| Name            | Description                                                                                   | Required | Default |
|-----------------|-----------------------------------------------------------------------------------------------|----------|---------|
| `linode_token`   | Linode API token to authenticate requests.                                                    | Yes      |         |
| `github_token`   | GitHub token to authenticate against the GitHub API.                                          | Yes      |         |
| `action`         | The action to perform: `"create"` to create a new machine, `"destroy"` to remove it.          | Yes      |         |
| `machine_id`     | The ID of the machine to destroy (required for destruction actions).                          | No       |         |
| `search_phrase`  | A search phrase to find a machine to destroy (used when no `machine_id` is provided).         | No       |         |
| `runner_label`   | The base label for the self-hosted runner. Defaults to `'self-hosted'` if not specified.      | No       |         |
| `root_password`  | The root password for the new Linode machine.                                                 | Yes      |         |
| `machine_type`   | The type of Linode machine to create.                                                         | Yes      |         |
| `image`          | The image to use for the Linode machine.                                                      | Yes      |         |
| `tags`           | Comma-separated list of tags for the Linode instance.                                         | No       |         |
| `organization`   | The GitHub organization name where the self-hosted runner will be registered.                 | Yes      |         |
| `repo_name`      | The GitHub repository name where the self-hosted runner will be registered.                   | Yes      |         |
| `blocked_ports`  | Ports to block on firewall.                                                                   | No       |         |
| `polling_time`   | Time interval in milliseconds between attempts to create Linode machines (to handle rate limits).                   | No      | 20000        |
| `timeout`        | Maximum time in milliseconds to keep retrying Linode machine creation.                                                                   | No       | 600000        |

## Outputs

| Name           | Description                              |
|----------------|------------------------------------------|
| `runner_label` | The label of the GitHub self-hosted runner that was created. |
| `machine_id`   | The ID of the Linode machine that was created or destroyed. |
| `machine_ip`   | The IP address of the Linode machine that was created.       |

## Example Usage

### Create a New Linode Machine and GitHub Self-Hosted Runner

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

### Destroy a Linode Machine

```yaml
jobs:
  destroy-machine:
    runs-on: ubuntu-latest
    steps:
      - name: Destroy Linode machine
        uses: kamilchodola/linode-github-runner@v1
        with:
          linode_token: ${{ secrets.LINODE_TOKEN }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
          action: 'destroy'
          machine_id: '12345'
          organization: 'your-org'
          repo_name: 'your-repo'
```

### Destroy a Self-Hosted Runner

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
          runner_label: 'self-hosted-runner'
          organization: 'your-org'
          repo_name: 'your-repo'
```

## Actions

- **create**: Creates a new Linode instance and sets it up as a GitHub self-hosted runner.
- **destroy**: Destroys both a Linode instance and unregisters the associated GitHub self-hosted runner.
- **destroy-machine**: Destroys a specific Linode machine.
- **destroy-runner**: Unregisters a specific GitHub self-hosted runner.

## Setup

Ensure you have the following secrets set in your GitHub repository:

- `LINODE_TOKEN`: Your Linode API token.
- `GITHUB_TOKEN`: A GitHub token with repository access and the ability to manage self-hosted runners.
- `ROOT_PASSWORD`: The root password for the Linode machine (used when creating a machine).
