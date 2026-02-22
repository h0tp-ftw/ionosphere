import { spawnSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

async function run() {
    console.log("=========================================");
    console.log("🚀 Ionosphere Update Utility");
    console.log("=========================================\n");

    try {
        // 1. Git Pull
        console.log("📥 Fetching latest changes from Git...");
        const pull = spawnSync('git', ['pull'], { stdio: 'inherit', shell: true });
        if (pull.status !== 0) {
            console.error("❌ Git pull failed. Please check your internet connection or resolve conflicts manually.");
            process.exit(1);
        }

        // 2. NPM Install
        console.log("\n📦 Updating dependencies...");
        const install = spawnSync('npm', ['install'], { stdio: 'inherit', shell: true });
        if (install.status !== 0) {
            console.error("❌ NPM install failed.");
            process.exit(1);
        }

        // 3. Container Rebuild (if .env exists)
        const envPath = path.join(process.cwd(), '.env');
        const isClean = process.argv.includes('--clean') || process.argv.includes('-c');

        if (fs.existsSync(envPath)) {
            console.log(isClean ? "\n🧹 Performing deep clean and rebuild..." : "\n🐳 Rebuilding containers...");

            // Determine compose command
            const dockerStatus = spawnSync('docker', ['--version']);
            const podmanStatus = spawnSync('podman', ['--version']);

            let composeCmd = '';
            if (!dockerStatus.error) composeCmd = 'docker-compose';
            if (!podmanStatus.error) {
                const hasPodmanCompose = !spawnSync('podman-compose', ['--version']).error;
                composeCmd = hasPodmanCompose ? 'podman-compose' : 'podman compose';
            }

            if (composeCmd) {
                if (isClean) {
                    console.log("🗑️  Removing existing images and volumes...");
                    spawnSync(`${composeCmd} down --rmi local -v --remove-orphans`, { stdio: 'inherit', shell: true });
                }

                console.log(`\n🏗️  Rebuilding Ionosphere image...`);
                const buildArgs = isClean ? 'build --no-cache' : 'build';
                console.log(`⏳ (This may take a few minutes)\n`);

                const buildProcess = spawn(`${composeCmd} ${buildArgs}`, { stdio: 'inherit', shell: true });

                buildProcess.on('exit', (code) => {
                    if (code === 0) {
                        console.log(`\n🚀 Restarting bridge container...`);
                        const upProcess = spawn(`${composeCmd} up -d`, { stdio: 'inherit', shell: true });

                        upProcess.on('exit', (upCode) => {
                            if (upCode === 0) {
                                console.log(`\n✅ Containers updated${isClean ? ' (clean build)' : ''} and restarted.`);
                            } else {
                                console.error(`\n❌ Restart failed (Exit code: ${upCode}).`);
                            }
                        });
                    } else {
                        console.error(`\n❌ Build failed (Exit code: ${code}).`);
                    }
                });
            } else {
                console.log("\n⚠️ No container engine found. Skipping container rebuild.");
            }
        }

        console.log("\n=========================================");
        console.log("🎉 Update Complete!");
        console.log("=========================================\n");

    } catch (err) {
        console.error("Update failed:", err.message);
        process.exit(1);
    }
}

run();
