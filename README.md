# fast-github

GitHub CDN 加速工具 - 自动查找最快 IP 并写入 hosts 文件

## 安装

```bash
npm install -g fast-github
```

## 使用方法

```bash
# 查找最快 IP 并写入 hosts（需要管理员权限）
github

# 只查找最快 IP，不写入
github go
```

## 功能特点

- 🚀 自动查找 GitHub 相关域名的最快 IP
- 🌐 支持多个 DNS 服务器（国内+海外）
- ⚡ 并发测速，快速找到最佳 IP
- 🔧 自动写入系统 hosts 文件
- 🧹 自动清理旧的配置

## 支持的域名

- `github.com`
- `raw.githubusercontent.com`
- `github.githubassets.com`
- `camo.githubusercontent.com`
- `avatars.githubusercontent.com`

## 注意事项

- 写入 hosts 文件需要管理员权限
- Windows: 以管理员身份运行命令行
- macOS/Linux: 使用 `sudo github`

## License

MIT
