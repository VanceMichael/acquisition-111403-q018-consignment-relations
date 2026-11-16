# 来源资料约定

港区舱单资料接收服务。现有单票归档；承运方另行发布分合关系和装载证据，全部为合成单据。

## 交互与身份

GET /bill返回单票；GET /notices含noticeId、leg、revision、replaces、bills、moves。bill包含billId/kind/status及显式parent；moves含cargoId/from/to，不等于单据删除。GET /loads/:id含leg/cargoId/container/packages/version。billId仅在承运方及运输段内唯一；notice内关系为一组发布，分开的load可迟到，quantity不作为关系证明。

## 外部变化

正常资料在 `fixtures/source.mjs`。同一来源可能处于这些外部阶段：regroup、missing-load、reload。集成测试通过来源实例的`setPhase`切换外部状态，这不是线上业务接口。阶段内同一URL的响应可以改变，其余URL保留正常资料；来源的请求轨迹在实例的`requests`中可查，控制方法不对网络开放。未知地址返回404，非法请求返回非成功状态。

## 已有收件边界

`src/reader.mjs`收取/bill单票、/notices关系声明与/loads/:id装载证据。单据、货物归属、声明原文与装载分别按承运方和运输段标识归档；关系仅来自声明的显式parent与moves，quantity不作为关系证明，号码相近不并票。notice为一组整体应用，moves不等于单据删除：票据撤销只改状态，货物归属只随moves变化。声明引用的票据或箱单缺失、声明与现有归属不符时登记未决事项交资料岗核对，不阻塞其余资料归档。每次接收将完整关系版本一次性提交归档，不暴露半截状态；已应用或被替换的声明重放不产生新版本，中断后重开归档可接着补收。归档按资料标识和内容摘要区分版本，原文按响应字节摘要独立存储，打开归档时逐份校验。来源文件、接收记录和对外查询不共享内存对象。未声明的协议能力不作推断；格式子集以本页和实际来源为准。
