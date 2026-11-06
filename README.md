# vibe-agents

两个「最小 Agent」并排放在一起，方便对照和面试演示。两边源目录 `D:\min-agent`、`D:\mini-agent` 仍保留，这里是拷贝后的合仓。

## 两个项目

### min-agent（Python）

用 **Grok Bot**（大领导 / 打工人流水线）做出来的 Python 最小 Agent：工具注册、LLM 解析、主循环、Session 落盘与压缩、CLI + Textual TUI。

进入目录与详细跑法见 [min-agent/README.md](min-agent/README.md)。面试照读剧本见 [min-agent/docs/DEMOS.md](min-agent/docs/DEMOS.md)。

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

用你自己的 **personal agent** 做出来的 TypeScript 最小 Agent。

进入目录与详细跑法见 [mini-agent/README.md](mini-agent/README.md)。

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
