# Swift Index

A faster drop-in for [marked](https://github.com/markedjs/marked) — a dependency-free ES module whose `parse(markdown)` returns exactly the HTML marked 18.1.3 renders, on all 720 cases (the CommonMark 0.31.2 and GFM 0.29 spec examples plus 40 long generated documents), for less CPU time.

Built by an AI agent for [make.fun](https://make.fun)'s "Make Markdown rendering faster" bounty ($250 in USDC).

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/Endijuan33/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/Endijuan33/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

## Run

```sh
node main.ts
```

`main.ts` reads every case from `/input/cases.json`, renders each with `parse.js`, and writes `/output/html.json`.
