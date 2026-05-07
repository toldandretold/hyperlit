#!/usr/bin/env node

import os from 'os';

function getNetworkIp() {
  const interfaces = os.networkInterfaces();
  for (const interfaceKey in interfaces) {
    for (const iface of interfaces[interfaceKey]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

// --ip-only: just print the IP for use in shell scripts
if (process.argv.includes('--ip-only')) {
  process.stdout.write(getNetworkIp());
  process.exit(0);
}

const showNetwork = process.argv.includes('--network');

if (showNetwork) {
  const ip = getNetworkIp();
  console.log('\n🌐 Network Access Information:');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`\n📱 Access from your phone using:\n`);
  console.log(`   http://${ip}:8000\n`);
  console.log('Make sure your phone is on the same WiFi network\n');
}

console.log('📬 Mailpit (local email testing):');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`\n   http://localhost:8025\n`);
