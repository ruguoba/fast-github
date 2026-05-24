#!/usr/bin/env node
/**
 * GitHub CDN 加速 CLI 工具
 * 用法:
 *   github          -> 自动写入系统 hosts（需管理员权限）
 *   github go       -> 查找最快 IP 并打印推荐 hosts
 *   github --help   -> 显示帮助
 *   github --version -> 显示版本
 */

const dns = require('dns');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ==================== 配置 ====================
const TARGET_DOMAINS = [
  'raw.githubusercontent.com',
  'github.githubassets.com',
  'camo.githubusercontent.com',
  'avatars.githubusercontent.com',
  'github.com',
];

const DNS_SERVERS = [
  // --- 国内 DNS（优先）---
  '223.5.5.5',        // 阿里
  '223.6.6.6',        // 阿里备用
  '119.29.29.29',     // 腾讯 DNSPod
  '119.28.28.28',     // DNSPod 备用
  '180.76.76.76',     // 百度
  '101.226.4.6',      // 360
  '218.30.118.6',     // 360 备用
  '114.114.114.114',  // 114 DNS
  '114.114.115.115',  // 114 备用
  '1.2.4.8',          // CNNIC
  '210.2.4.8',        // CNNIC 备用
  '101.101.101.101',  // CNNIC 额外

  // --- 海外 DNS（备用）---
  '8.8.8.8',          // Google
  '8.8.4.4',          // Google 备用
  '1.1.1.1',          // Cloudflare
  '1.0.0.1',          // Cloudflare 备用
  '9.9.9.9',          // Quad9
  '149.112.112.112',  // Quad9 备用
  '208.67.222.222',   // OpenDNS
  '208.67.220.220',   // OpenDNS 备用
  '4.2.2.1',          // Level3
  '4.2.2.2',          // Level3 备用
];

const PORT = 443;
const TIMEOUT = 2000; // 毫秒
const DNS_TIMEOUT = 3000; // DNS 解析超时

// ==================== 工具函数 ====================
function isPrivateIP(ip) {
  const parts = ip.split('.').map(Number);
  // 10.0.0.0/8
  if (parts[0] === 10) return true;
  // 172.16.0.0/12
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  // 192.168.0.0/16
  if (parts[0] === 192 && parts[1] === 168) return true;
  // 127.0.0.0/8
  if (parts[0] === 127) return true;
  // 169.254.0.0/16
  if (parts[0] === 169 && parts[1] === 254) return true;
  return false;
}

function resolveWithDns(domain, dnsServer) {
  return new Promise((resolve) => {
    const resolver = new dns.Resolver();
    resolver.setServers([dnsServer]);
    
    const timer = setTimeout(() => {
      resolve([]);
    }, DNS_TIMEOUT);
    
    resolver.resolve4(domain, (err, addresses) => {
      clearTimeout(timer);
      if (err) {
        resolve([]);
      } else {
        // 过滤私有 IP
        resolve(addresses.filter(ip => !isPrivateIP(ip)));
      }
    });
  });
}

function testLatency(ip) {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = new net.Socket();

    socket.setTimeout(TIMEOUT);
    socket.on('connect', () => {
      const elapsed = Date.now() - start;
      socket.destroy();
      resolve(elapsed);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(Infinity);
    });
    socket.on('error', () => {
      socket.destroy();
      resolve(Infinity);
    });

    socket.connect(PORT, ip);
  });
}

async function getBestIPs(domain) {
  // 1. 多 DNS 并发解析
  const results = await Promise.all(
    DNS_SERVERS.map(dnsServer => resolveWithDns(domain, dnsServer))
  );
  const allIPs = [...new Set(results.flat())];
  if (allIPs.length === 0) return [];

  // 2. 并发测速
  const latencyResults = await Promise.all(
    allIPs.map(ip => testLatency(ip).then(latency => ({ ip, latency })))
  );

  // 3. 过滤超时 IP，按延迟升序排列
  return latencyResults
    .filter(r => r.latency !== Infinity)
    .sort((a, b) => a.latency - b.latency);
}

function generateHostsText(bestMap, topN = 1) {
  let lines = ['# === GitHub CDN Start ==='];
  for (const [domain, list] of Object.entries(bestMap)) {
    if (list.length === 0) {
      lines.push(`# ${domain}  无可用 IP`);
      continue;
    }
    for (const { ip, latency } of list.slice(0, topN)) {
      lines.push(`${ip}\t${domain}\t# ${latency}ms`);
    }
  }
  lines.push('# === GitHub CDN End ===');
  return lines.join('\n');
}

function getHostsPath() {
  if (process.platform === 'win32') {
    return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts');
  }
  return '/etc/hosts';
}

function cleanOldHosts(content) {
  const startMarker = '# === GitHub CDN Start ===';
  const endMarker = '# === GitHub CDN End ===';
  const startIndex = content.indexOf(startMarker);
  const endIndex = content.indexOf(endMarker);
  
  // 安全检查：两个标记必须都存在
  if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
    return content.substring(0, startIndex) + content.substring(endIndex + endMarker.length);
  }
  return content;
}

function backupHostsFile(hostsPath) {
  const backupPath = hostsPath + '.bak.' + Date.now();
  try {
    fs.copyFileSync(hostsPath, backupPath);
    return backupPath;
  } catch (err) {
    return null;
  }
}

function flushDNS() {
  const platform = process.platform;
  let cmd, manualCmd;

  if (platform === 'win32') {
    cmd = 'ipconfig /flushdns';
    manualCmd = 'ipconfig /flushdns';
  } else if (platform === 'darwin') {
    cmd = 'sudo dscacheutil -flushcache';
    manualCmd = 'sudo dscacheutil -flushcache';
  } else {
    cmd = 'sudo systemd-resolve --flush-caches';
    manualCmd = 'sudo systemd-resolve --flush-caches 或 sudo systemctl restart nscd';
  }

  try {
    execSync(cmd, { stdio: 'ignore' });
    console.log('✅ DNS缓存已刷新');
  } catch (err) {
    console.log(`⚠️ DNS缓存刷新失败，请手动执行: ${manualCmd}`);
  }
}

function writeHostsFile(bestMap) {
  const hostsPath = getHostsPath();
  
  try {
    // 读取现有内容
    let content = fs.readFileSync(hostsPath, 'utf8');
    
    // 备份原文件
    const backupPath = backupHostsFile(hostsPath);
    if (backupPath) {
      console.log(`📋 已备份原文件到: ${backupPath}`);
    }
    
    // 清除旧的 GitHub CDN 配置
    content = cleanOldHosts(content);
    
    // 生成新配置
    const newConfig = generateHostsText(bestMap, 1);
    
    // 写入文件
    fs.writeFileSync(hostsPath, content + '\n' + newConfig + '\n');
    console.log(`\n✅ 已自动写入 ${hostsPath}`);
    flushDNS();
  } catch (err) {
    console.error(`\n❌ 写入 ${hostsPath} 失败：${err.message}`);
    console.log('\n请使用管理员权限运行（sudo / 管理员命令行），或手动复制以下内容：');
    console.log(generateHostsText(bestMap, 1));
  }
}

function showHelp() {
  console.log(`
fast-github - GitHub CDN 加速工具

用法:
  github          自动查找最快 IP 并写入 hosts（需管理员权限）
  github go       只查找最快 IP，不写入
  github --help   显示此帮助
  github --version 显示版本

示例:
  # Windows (管理员命令行)
  github
  
  # macOS/Linux
  sudo github
  
  # 只查看结果
  github go
`);
}

function showVersion() {
  const pkg = require('./package.json');
  console.log(`fast-github v${pkg.version}`);
}

// ==================== 主流程 ====================
async function main() {
  const arg = process.argv[2];
  
  // 处理参数
  if (arg === '--help' || arg === '-h') {
    showHelp();
    return;
  }
  if (arg === '--version' || arg === '-v') {
    showVersion();
    return;
  }
  
  const mode = arg === 'go' ? 'go' : 'set';
  
  console.log(`🔍 正在查找 ${TARGET_DOMAINS.length} 个域名的最快 IP...`);
  console.log('   这可能需要 10-30 秒，请耐心等待...\n');
  
  const bestMap = {};
  
  // 并发处理所有域名
  const domainResults = await Promise.all(
    TARGET_DOMAINS.map(async domain => {
      process.stdout.write(`⏳ 处理 ${domain} ... `);
      const list = await getBestIPs(domain);
      console.log(list.length > 0 ? `找到 ${list[0].latency}ms` : '无可用 IP');
      return [domain, list];
    })
  );
  
  // 构建结果映射
  for (const [domain, list] of domainResults) {
    bestMap[domain] = list;
  }

  if (mode === 'go') {
    // 查找模式：只显示结果
    console.log('\n📊 推荐 hosts 配置:');
    console.log(generateHostsText(bestMap, 1));
  } else {
    // 设置模式：写入 hosts
    console.log('\n📝 即将写入以下配置到 hosts 文件:');
    console.log(generateHostsText(bestMap, 1));
    writeHostsFile(bestMap);
  }
}

main().catch(console.error);
