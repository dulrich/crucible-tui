# Wide-table fixture

This fixture exists for WP-3's allocator gates. It is deliberately hostile: a very
wide source row, long unbreakable tokens of the exact kind this corpus is full of,
all three alignment markers, and a CJK + emoji row.

| Command | Config Path | Test File | Description | Owner | Notes |
| :--- | :---: | ---: | :--- | :---: | ---: |
| bun run design:verify | example/config-presets/templates/gitignore/ | example/backend/services/api/src/csv-importer.test.ts | This row exists to stress the wide-table allocator with long unbreakable tokens that must never be truncated or ellipsized under any circumstances by the renderer under test, and it keeps going so the raw source line clears the corpus's measured p99 width | wp-3 | pending review |
| 你好世界 测试宽表格式 🎉 | 路径/示例/演示 | 测试文件.md | 中文和表情符号混排的行,用于验证宽度对齐与列分割逻辑是否仍然正确 🚀 | 所有者 | 备注信息 |
| bun run design:verify | example/config-presets/templates/gitignore/ | example/backend/services/api/src/csv-importer.test.ts | short | wp-3 | ok |
