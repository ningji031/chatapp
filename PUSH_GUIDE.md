# GitHub 推送步骤

在 Windows 电脑上打开 Git Bash 或 CMD，执行：

```bash
cd "C:\ProgramData\WorkBuddy\chromium-env\135xeo1\WorkBuddy\2026-06-07-17-23-22\chatapp"

git branch -M main
git push -u origin main
```

如果提示要登录，有 2 种方式：

## 方式一：Personal Access Token（推荐）

1. 打开：https://github.com/settings/tokens/new
2. 勾选 `repo` 权限，点 Generate token
3. 复制生成的 token（只显示一次）
4. 推送时密码处粘贴这个 token

## 方式二：GitHub CLI

```bash
# 先安装 gh：https://cli.github.com/
gh auth login
git push -u origin main
```

---

推送成功后，仓库地址：
https://github.com/ningji031/chatapp
