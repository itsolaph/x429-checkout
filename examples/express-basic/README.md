# x429 example: Express

`GET /forecast?city=` behind an x429 lane, one request per 15 s. See [../README.md](../README.md) for
the exact commands: a local anvil fork of Base, `npx x429 deploy`, `npx x429 queue create`, then

```sh
X429_RPC_URL=http://127.0.0.1:8545 X429_CONTRACT=<address> X429_QUEUE_ID=1 \
X429_OPERATOR_KEY_FILE=/tmp/x429-operator.key npm start
```
