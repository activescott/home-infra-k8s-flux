#!/usr/bin/env npx tsx

import { execSync } from 'child_process';
import { Octokit } from '@octokit/rest';
import * as readline from 'readline';

interface ImageRepository {
  name: string;
  namespace: string;
  image: string;
}

interface GitHubRepo {
  owner: string;
  repo: string;
  imageRepositories: ImageRepository[];
}

interface WebhookResult {
  owner: string;
  repo: string;
  action: 'created' | 'updated' | 'unchanged';
  webhookUrl?: string;
  pingStatus?: 'success' | 'failed' | 'skipped';
  hookId?: number;
}

async function promptForToken(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    process.stdout.write(prompt);

    if (!process.stdin.isTTY) {
      // Non-interactive mode - just read a line
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      rl.question('', (answer) => {
        rl.close();
        resolve(answer);
      });
      return;
    }

    // Interactive mode - hide input and show asterisks
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    let token = '';

    const onData = (char: string) => {
      // Handle Enter key
      if (char === '\n' || char === '\r') {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(token);
        return;
      }

      // Handle Ctrl+C
      if (char === '\u0003') {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener('data', onData);
        process.stdout.write('\n');
        process.exit(1);
      }

      // Handle backspace
      if (char === '\u007F' || char === '\b') {
        if (token.length > 0) {
          token = token.slice(0, -1);
          process.stdout.write('\b \b');
        }
        return;
      }

      // Regular character
      token += char;
      process.stdout.write('*');
    };

    process.stdin.on('data', onData);
  });
}

class UpdateFluxImageScanningWebhooks {
  private octokit: Octokit;
  private webhookUrl: string = '';
  private webhookSecret: string = '';
  private results: WebhookResult[] = [];

  private constructor(githubToken: string) {
    this.octokit = new Octokit({
      auth: githubToken,
    });
  }

  static async create(): Promise<UpdateFluxImageScanningWebhooks> {
    let githubToken = process.env.GITHUB_TOKEN;

    if (!githubToken) {
      console.log('GITHUB_TOKEN not found in environment.');
      githubToken = await promptForToken('Enter GITHUB_TOKEN: ');

      if (!githubToken) {
        throw new Error('GITHUB_TOKEN is required');
      }
    }

    return new UpdateFluxImageScanningWebhooks(githubToken);
  }

  private execKubectl(command: string): string {
    try {
      return execSync(`kubectl --context nas ${command}`, { encoding: 'utf8' });
    } catch (error) {
      console.error(`Failed to execute kubectl command: ${command}`);
      throw new Error(`kubectl command failed: ${error}`);
    }
  }

  private async getImageRepositories(): Promise<ImageRepository[]> {
    console.log('Discovering ImageRepositories in cluster...');
    
    const output = this.execKubectl('get imagerepository -A -o json');
    const result = JSON.parse(output);
    
    const imageRepos: ImageRepository[] = result.items.map((item: any) => ({
      name: item.metadata.name,
      namespace: item.metadata.namespace,
      image: item.spec.image,
    }));

    console.log(`Found ${imageRepos.length} ImageRepositories:`);
    imageRepos.forEach(repo => {
      console.log(`  - ${repo.name} (${repo.namespace}): ${repo.image}`);
    });

    return imageRepos;
  }

  private async getWebhookConfig(): Promise<void> {
    console.log('Getting webhook configuration from cluster...');

    // Get receiver URL and secret reference
    const receiverOutput = this.execKubectl('get receiver webhook-receiver-image -n flux-system -o json');
    const receiver = JSON.parse(receiverOutput);
    const receiverUrl = receiver.status?.webhookPath || receiver.status?.url;
    
    if (!receiverUrl) {
      throw new Error('Could not find webhook URL in receiver status');
    }

    this.webhookUrl = `https://flux-webhook.activescott.com${receiverUrl}`;

    // Get webhook secret using the actual secret name from receiver spec
    const secretName = receiver.spec?.secretRef?.name;
    if (!secretName) {
      throw new Error('Could not find secret reference in receiver spec');
    }

    const secretOutput = this.execKubectl(`get secret ${secretName} -n flux-system -o json`);
    const secret = JSON.parse(secretOutput);
    this.webhookSecret = Buffer.from(secret.data.token, 'base64').toString('utf8');

    console.log(`Webhook URL: ${this.webhookUrl}`);
    console.log(`Secret configured: ${this.webhookSecret ? 'Yes' : 'No'}`);
  }

  private parseImageToGitHub(image: string): { owner: string; repo: string } | null {
    // Parse GHCR images like: ghcr.io/activescott/www or ghcr.io/tayle-co/tayle/app
    const match = image.match(/^ghcr\.io\/([^\/]+)\/([^\/]+)/);
    if (!match) {
      return null;
    }

    return {
      owner: match[1],
      repo: match[2],
    };
  }

  private groupImageRepositoriesByGitHub(imageRepos: ImageRepository[]): GitHubRepo[] {
    const githubRepos = new Map<string, GitHubRepo>();

    for (const imageRepo of imageRepos) {
      const parsed = this.parseImageToGitHub(imageRepo.image);
      if (!parsed) {
        console.log(`⚠️  Skipping non-GHCR image: ${imageRepo.image}`);
        continue;
      }

      const key = `${parsed.owner}/${parsed.repo}`;
      if (!githubRepos.has(key)) {
        githubRepos.set(key, {
          owner: parsed.owner,
          repo: parsed.repo,
          imageRepositories: [],
        });
      }

      githubRepos.get(key)!.imageRepositories.push(imageRepo);
    }

    return Array.from(githubRepos.values());
  }

  private async getExistingWebhook(owner: string, repo: string): Promise<any | null> {
    try {
      const { data: webhooks } = await this.octokit.rest.repos.listWebhooks({
        owner,
        repo,
      });

      return webhooks.find(webhook => 
        webhook.config?.url === this.webhookUrl
      ) || null;
    } catch (error: any) {
      if (error.status === 404) {
        console.log(`⚠️  Repository ${owner}/${repo} not found or no access:`, (error as any).message || error);
        return null;
      }
      throw error;
    }
  }

  private async createWebhook(owner: string, repo: string): Promise<WebhookResult> {
    console.log(`Creating webhook for ${owner}/${repo}...`);

    try {
      const response = await this.octokit.rest.repos.createWebhook({
        owner,
        repo,
        config: {
          url: this.webhookUrl,
          content_type: 'json',
          secret: this.webhookSecret,
        },
        events: ['package'],
        active: true,
      });

      console.log(`Created webhook for ${owner}/${repo}`);
      
      // Ping the webhook to test it
      const pingStatus = await this.pingWebhook(owner, repo, response.data.id);
      
      return {
        owner,
        repo,
        action: 'created',
        webhookUrl: `https://github.com/${owner}/${repo}/settings/hooks`,
        hookId: response.data.id,
        pingStatus,
      };
    } catch (error: any) {
      console.error(`Failed to create webhook for ${owner}/${repo}: ${error.message}`);
      return { owner, repo, action: 'unchanged' };
    }
  }

  private async updateWebhook(owner: string, repo: string, hookId: number): Promise<WebhookResult> {
    console.log(`Updating webhook for ${owner}/${repo}...`);

    try {
      await this.octokit.rest.repos.updateWebhook({
        owner,
        repo,
        hook_id: hookId,
        config: {
          url: this.webhookUrl,
          content_type: 'json',
          secret: this.webhookSecret,
        },
        events: ['package'],
        active: true,
      });

      console.log(`Updated webhook for ${owner}/${repo}`);
      
      // Ping the webhook to test it
      const pingStatus = await this.pingWebhook(owner, repo, hookId);
      
      return {
        owner,
        repo,
        action: 'updated',
        webhookUrl: `https://github.com/${owner}/${repo}/settings/hooks`,
        hookId,
        pingStatus,
      };
    } catch (error: any) {
      console.error(`Failed to update webhook for ${owner}/${repo}: ${error.message}`);
      return { owner, repo, action: 'unchanged' };
    }
  }

  private async pingWebhook(owner: string, repo: string, hookId: number): Promise<'success' | 'failed'> {
    try {
      console.log(`Pinging webhook for ${owner}/${repo}...`);
      await this.octokit.rest.repos.pingWebhook({
        owner,
        repo,
        hook_id: hookId,
      });
      console.log(`Webhook ping successful for ${owner}/${repo}`);
      return 'success';
    } catch (error: any) {
      console.error(`Webhook ping failed for ${owner}/${repo}: ${error.message}`);
      return 'failed';
    }
  }

  private isWebhookCorrect(webhook: any): { correct: boolean; differences: string[] } {
    const differences: string[] = [];

    if (webhook.config?.url !== this.webhookUrl) {
      differences.push(`URL: "${webhook.config?.url}" → "${this.webhookUrl}"`);
    }

    if (webhook.config?.content_type !== 'json') {
      differences.push(`Content-Type: "${webhook.config?.content_type}" → "json"`);
    }

    if (!webhook.events?.includes('package')) {
      const currentEvents = webhook.events ? webhook.events.join(', ') : 'none';
      differences.push(`Events: [${currentEvents}] → [package]`);
    }

    if (webhook.active !== true) {
      differences.push(`Active: ${webhook.active} → true`);
    }

    // Check if secret is configured (we can't see the actual value for security)
    if (!webhook.config?.secret) {
      differences.push(`Secret: not configured → configured`);
    }

    return {
      correct: differences.length === 0,
      differences
    };
  }

  async run(): Promise<void> {
    console.log('Starting Flux Image Scanning Webhook Update\n');

    try {
      // Check if kubectl is available
      this.execKubectl('version --client=true');
      console.log('kubectl is available\n');

      // Get cluster configuration
      await this.getWebhookConfig();
      console.log();

      // Discover ImageRepositories
      const imageRepos = await this.getImageRepositories();
      console.log();

      // Group by GitHub repository
      const githubRepos = this.groupImageRepositoriesByGitHub(imageRepos);
      
      console.log(`Will manage webhooks for ${githubRepos.length} GitHub repositories:`);
      githubRepos.forEach(repo => {
        console.log(`  - ${repo.owner}/${repo.repo} (${repo.imageRepositories.length} ImageRepositories)`);
      });
      console.log();

      // Process each GitHub repository
      for (const githubRepo of githubRepos) {
        console.log(`Checking ${githubRepo.owner}/${githubRepo.repo}...`);

        const existingWebhook = await this.getExistingWebhook(githubRepo.owner, githubRepo.repo);

        let result: WebhookResult;
        
        if (!existingWebhook) {
          result = await this.createWebhook(githubRepo.owner, githubRepo.repo);
        } else {
          const validation = this.isWebhookCorrect(existingWebhook);
          if (!validation.correct) {
            console.log(`Webhook exists but needs updating:`);
            validation.differences.forEach(diff => {
              console.log(`   ${diff}`);
            });
            result = await this.updateWebhook(githubRepo.owner, githubRepo.repo, existingWebhook.id);
          } else {
            console.log(`Webhook already correctly configured for ${githubRepo.owner}/${githubRepo.repo}`);
            
            // Still ping the webhook to test it
            const pingStatus = await this.pingWebhook(githubRepo.owner, githubRepo.repo, existingWebhook.id);
            
            result = {
              owner: githubRepo.owner,
              repo: githubRepo.repo,
              action: 'unchanged',
              webhookUrl: `https://github.com/${githubRepo.owner}/${githubRepo.repo}/settings/hooks`,
              hookId: existingWebhook.id,
              pingStatus,
            };
          }
        }
        
        this.results.push(result);
        console.log();
      }

      console.log('Flux image scanning webhook update completed!');
      console.log();
      
      // Print summary with clickable links
      console.log('Webhook Summary:');
      this.results.forEach(result => {
        const emoji = result.action === 'created' ? '🆕' : 
                     result.action === 'updated' ? '🔄' : '✅';
        const status = result.action === 'created' ? 'CREATED' :
                      result.action === 'updated' ? 'UPDATED' : 'UNCHANGED';
        
        const pingEmoji = result.pingStatus === 'success' ? '🟢' :
                         result.pingStatus === 'failed' ? '🔴' : '⚪';
        const pingText = result.pingStatus === 'success' ? 'PING OK' :
                        result.pingStatus === 'failed' ? 'PING FAILED' : 'NO PING';
        
        console.log(`${emoji} ${result.owner}/${result.repo} [${status}] ${pingEmoji} ${pingText}`);
        if (result.webhookUrl) {
          console.log(`   ${result.webhookUrl}`);
        }
      });

    } catch (error: any) {
      console.error(`❌ Error: ${error.message}`);
      process.exit(1);
    }
  }
}

// Run the script
if (require.main === module) {
  UpdateFluxImageScanningWebhooks.create()
    .then((updater) => updater.run())
    .catch((error) => {
      console.error(`❌ Error: ${error.message}`);
      process.exit(1);
    });
}
