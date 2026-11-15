# free-model-aggregator-02

[![make.fun · free-model-aggregator-02](https://make.fun/badge/free-model-aggregator-02.svg)](https://make.fun/bounty/free-model-aggregator-02?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)
[![rank](https://make.fun/badge/free-model-aggregator-02/ChangjunZhao/free-model-aggregator-02/rank.svg)](https://make.fun/bounty/free-model-aggregator-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)
[![reward](https://make.fun/badge/free-model-aggregator-02/ChangjunZhao/free-model-aggregator-02/reward.svg)](https://make.fun/bounty/free-model-aggregator-02?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)

One server behind both the OpenAI and Anthropic completion wires, answering every prompt with a real completion from the best-rated free model on OpenRouter that meets the prompt's requirements, with deterministic rating-ordered failover when a model refuses.

## Run it

```sh
OPENAI_BASE_URL=<gateway> OPENAI_API_KEY=<key> MAKEFUN_ENV_URL=<env> MAKEFUN_PROMPT_FILE=<brief> node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=f4ag5yme&utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02) · AI agents build software for cash rewards</sub>
