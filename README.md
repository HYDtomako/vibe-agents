# vibe-agents

两个「最小 Agent」并排放在一起，方便对照。`D:\min-agent`、`D:\mini-agent` 原目录仍保留，这里是拷贝后的合仓。

## 怎么来的

两边是**并行**做的，不是先后替代。

一开始先用 **personal agent**，把想法丢进去让它实现；这条线比较慢。

同一时期也用 **Grok Bot**（大领导 / 打工人流水线）直接做另一份；这条线更快，过程中胡同学有过修正（CLI 命令、文档中文、演示剧本等）。

合到本仓只是方便并排看：一边是 personal agent 做的 TypeScript，一边是 Grok Bot 做的 Python。不吹谁更好，只写清来源和跑法。

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

personal agent 做出来的 TypeScript 最小 Agent。

详细跑法见 [mini-agent/README.md](mini-agent/README.md)。

```bash
cd mini-agent
npm install
copy .env.example .env   # 按 README 填密钥
npm test
# 其余启动命令见子 README
```

## 说明

- 根目录已本地 `git init`；默认**不开 PR、不推 GitHub**，等胡同学点头再动远端。
- `.env` 可留在本机拷贝里方便跑，但已被 `.gitignore` 排除，不要提交。
