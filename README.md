# 港区舱单的分票合票修订接收

港区舱单资料接收服务。除现有单票归档外，同时接收承运方发布的分票合票关系声明与装载证据，全部为合成单据。

## 运行

使用 Node.js 22，依赖由 package-lock.json 固定。安装后可执行：

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run demo
npm start
```

服务启动本地来源与收件接口，默认端口分别为4011和4010。`POST /collect` 执行一次接收（单票、关系声明与装载证据）；`GET /relations`查看当前自洽关系，`GET /pending`查看待资料岗核对的未决事项，`GET /records`查看结构化记录全部版本，`GET /receipts`查看原文凭据，`GET /health`查看服务状态。`PORT`、`SOURCE_PORT`与`DATA_DIR`可分别设置端口和归档目录。示例领取不会自动遍历其他来源资料。

```sh
docker build -t consignment-relations .
docker run --rm --network none consignment-relations npm test
docker run --rm --network none consignment-relations npm run demo
docker run --rm -p 4010:4010 consignment-relations
```

## 资料组织

`provider/`是独立本地来源，`fixtures/`记录合成资料和来源阶段。`src/reader.mjs`负责收件：单票（/bill）、关系声明（/notices）与装载证据（/loads/:id）分别归档，运输段、单据修订与实物装载使用各自标识；关系只取声明中的显式parent与moves，不按号码相近或件数相等推测；票据撤销只改状态，不删除已迁移的货物；缺少关联票据或箱单时登记未决事项交资料岗核对。`src/source.mjs`限定来源地址并记录响应字节，`src/archive.mjs`保存按摘要校验的原文与资料版本；每次接收把完整关系版本一次性提交，中断后重开归档可接着补收，重放不产生重复版本。`test/`覆盖现有收件、来源边界、原文完整性、分票合票修订和服务联通。运行不依赖外网、数据库服务或真实设备。

完整来源约定见 `docs/source-contract.md`。项目只访问本地合成资料，不携带真实身份、密钥或业务数据。

## 快速查看

`npm run demo`启动实际来源和收件服务，依次演示分票接收、合票修订、箱单缺失与补收，并打印查询结果及凭据，临时归档在退出时清理。正常完成时间小于90秒；需要保留数据时用`npm start`及独立`DATA_DIR`。演示反映当前产品能力，不代表全部来源资料已被接纳。
