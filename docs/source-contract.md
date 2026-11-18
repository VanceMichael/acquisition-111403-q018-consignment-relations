# 来源资料约定

港区舱单资料接收服务。单票、分合关系与装载证据一并归档，全部为合成单据。

## 交互与身份

GET /bill返回单票；GET /notices含noticeId、leg、revision、replaces、bills、moves。bill包含billId/kind/status及显式parent；moves含cargoId/from/to，不等于单据删除。GET /loads/:id含leg/cargoId/container/packages/version。billId仅在承运方及运输段内唯一；notice内关系为一组发布，分开的load可迟到，quantity不作为关系证明。

## 外部变化

正常资料在 `fixtures/source.mjs`。同一来源可能处于这些外部阶段：regroup、missing-load。集成测试通过来源实例的`setPhase`切换外部状态，这不是线上业务接口。阶段内同一URL的响应可以改变，其余URL保留正常资料；来源的请求轨迹在实例的`requests`中可查，控制方法不对网络开放。未知地址返回404，非法请求返回非成功状态。

## 收件边界

`src/reader.mjs`收取/bill的单票资料，并经`src/relations.mjs`收取/notices的分合声明与/loads/:id的箱单。运输段、单据修订与实物装载分别记录为relation、notice、load三类身份；分合声明与箱单记录回指原文凭据摘要。关系版本按声明修订链整体折叠、随当次收件一次性提交，货物在同一版本内只归属一张单据，归属只随显式迁移声明改变，不按号码或数量推断。缺少关联票据或箱单时在关系版本的pending中登记未决原因，交由资料岗核对，后续收件自动补取。归档按资料标识和内容摘要区分版本，原文按响应字节摘要独立存储，打开归档时逐份校验。来源文件、接收记录和对外查询不共享内存对象。未声明的协议能力不作推断；格式子集以本页和实际来源为准。
