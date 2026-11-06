# vibe-agents

两个「最小 Agent」并排放在一起，方便对照。`D:\min-agent`、`D:\mini-agent` 原目录仍保留，这里是拷贝后的合仓。

## 怎么做出来的

- 先跟 **personal agent** 交流，把设计想法告诉它；personal agent 据此做了一份，就是现在的 **mini-agent**（TypeScript）。
- **Grok Bot**（大领导 / 打工人流水线）是更放开、直接开做的做法，做出的是 **min-agent**（Python）；过程中胡同学有过修正。
- 两边是**并行**推进的，合到本仓方便并排对照。不吹谁更好，只写清来源和跑法。

## 两个项目

### min-agent（Python）

Grok Bot 流水线做出来的 Python 最小 Agent：工具注册、LLM 解析、主循环、Session 落盘与压缩、CLI + Textual TUI。

详细跑法见 [min-agent/README.md](min-agent/README.md)。面试照读剧本见 [min-agent/docs/DEMOS.md](min-agent/docs/DEMOS.md)。

```bash
cd min-agent
python -m venv .venv
# Windows: .\.venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env   # 填入 DEEPSEEK_API_KEY
python main.py
python main.py --tui
```

### mini-agent（TypeScript）

personal agent 按设计想法做出来的 TypeScript 最小 Agent。

详细跑法见 [mini-agent/README.md](mini-agent/README.md)。

```bash
cd mini-agent
npm install
copy .env.example .env   # 按 README 填密钥
npm test
# 其余启动命令见子 README
```

## 架构设计题回答

飞书笔试 5 个模块各选一题的口述稿，整理成文的版本：[架构设计题.md](架构设计题.md)

## 说明

- 根目录已本地 `git init`；默认**不开 PR、不推 GitHub**，等胡同学点头再动远端。
- `.env` 可留在本机拷贝里方便跑，但已被 `.gitignore` 排除，不要提交。
