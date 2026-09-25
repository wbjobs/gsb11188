# 6 步配置向导（可分享状态）

纯前端实现：DOM + URL API + IndexedDB + Web Worker（压缩），无后端、无构建步骤。

## 运行

ES Module 和 Web Worker 需要通过 HTTP 访问，启动任意静态服务器：

```bash
python3 -m http.server 8000
# 打开 http://localhost:8000
```

## 功能

- 6 步向导，步骤间自由跳转，第 6 步为汇总确认
- 「生成分享链接」把当前状态序列化为 URL（`#c=w1.d...`）或字符串
- 粘贴字符串 / 完整 URL 可精确恢复状态
- 刷新页面后状态从 IndexedDB 自动恢复

## 设计要点

- **压缩**：Web Worker 中使用 `CompressionStream(deflate-raw)`，不支持的浏览器退化为未压缩（格式标记 `r`）
- **URL 长度限制**：超过 1800 字符时降级为短链接（`#s=<id>`，内容存本地 IndexedDB），并提示跨设备复制完整字符串
- **非法状态**：编码损坏、JSON 损坏、缺版本信息均有明确提示；被篡改数据按 schema 矫正（未知键丢弃、非法枚举回退默认）
- **版本兼容**：payload 带版本号；旧版本经迁移表升级，新版本按兼容模式尽力恢复并提示
- **敏感信息**：schema 中标记 `sensitive` 的字段（手机号、证件号、地址）只存本地，绝不进入序列化结果
- **可读性**：分享面板可展开查看过滤后的明文 JSON

## 文件结构

- `index.html` / `styles.css` — 页面与样式
- `js/schema.js` — 步骤/字段定义、默认值、敏感字段、版本迁移表
- `js/serializer.js` — 序列化、反序列化、校验矫正、base64url
- `js/compress-worker.js` — 压缩/解压 Worker
- `js/db.js` — IndexedDB 封装（状态持久化 + 短链接存储）
- `js/app.js` — 向导渲染与交互
