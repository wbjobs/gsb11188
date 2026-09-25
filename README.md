# 六步配置向导 · 可分享状态

纯前端实现：DOM + URL API + IndexedDB + Web Worker（压缩），无构建、无后端、无提交、无表单校验。

## 运行

Web Worker 与 IndexedDB 要求 http(s) 源，不能用 `file://` 直接打开：

```bash
python3 -m http.server 8000
# 打开 http://localhost:8000
```

## 测试

```bash
node test/serializer.test.mjs   # 10 个用例，覆盖序列化核心逻辑
```

## 结构

- `index.html` — 向导页面骨架
- `js/app.js` — 六步 schema、渲染、状态流、分享与降级
- `js/serializer.js` — 序列化/反序列化、敏感过滤、校验和、版本迁移与降级（环境无关，可单测）
- `js/compress-worker.js` — Web Worker 内 deflate-raw 压缩/解压（CompressionStream）
- `js/storage.js` — IndexedDB 封装（`state` 刷新保持，`shares` 短键降级）

## 序列化格式

- 明文：`WZ.<base64url(JSON)>`，JSON 为 `{ c: 校验和, body: { v, step, data } }`
- 压缩：`WZC.<base64url(deflate-raw(JSON))>`，由 Worker 生成
- 分享链接：`#s=<串>`；超限时降级为 `#k=<短键>`（完整串存 IndexedDB，仅本浏览器可恢复），同时完整串展示在文本框供手动复制

## 验收标准对照

| 标准 | 实现 |
| --- | --- |
| 任意步骤状态可序列化 | `step` 字段随 data 一起入信封，测试逐步骤验证 |
| 分享后精确恢复 | FNV-1a 校验和 + 往返测试（含压缩链路） |
| URL 长度超限降级 | 2000 字符阈值 → IndexedDB 短键链接 + 完整串手动复制 |
| 非法状态提示 | 坏前缀/坏 Base64/坏 JSON/校验和不匹配/结构缺失，toast 报错 |
| 版本不兼容降级 | 低版本走 `MIGRATIONS` 逐级迁移；高版本按 schema 白名单裁剪并告警 |
| 敏感信息过滤 | schema `sensitive` 标记 + 内置 key 黑名单，序列化与反序列化双向过滤 |
| 刷新后状态保持 | 每次变更防抖写入 IndexedDB，启动时恢复 |
| 序列化结果可读 | 明文格式可解码为 JSON；页面提供「查看明文状态」 |
