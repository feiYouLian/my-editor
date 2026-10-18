**轻量级定制文本编辑器**

**图片文字提取（OCR）功能技术设计文档**

v1.0

| 项目     | 内容                                         |
| -------- | -------------------------------------------- |
| 文档类型 | 功能专项技术设计文档（选型 / 模型转换 / 模块设计） |
| 版本     | v1.0                                         |
| 日期     | 2026-10-18                                   |
| 状态     | 待评审                                       |
| 上位文档 | 《轻量级定制文本编辑器_技术设计文档》v1.3    |

**修订记录**

| 版本 | 日期       | 说明 |
| ---- | ---------- | ---- |
| v1.0 | 2026-10-18 | 初稿：方案选型（PaddleOCR ONNX 化路线）、模型转换步骤、Rust 推理核心设计、前端交互设计、体积/性能预算、风险与开发计划 |

**决策索引**

| 编号 | 决策                                                   |
| ---- | ------------------------------------------------------ |
| O-1  | OCR 引擎采用 PP-OCRv4 mobile 模型转 ONNX，Rust `ort` 推理，不引入 Python/Paddle 运行时 |
| O-2  | 安装包体积指标放宽：<15MB → <55MB（OCR 功能启用后）；模型随包分发，不做在线下载（v1） |
| O-3  | 图像输入仅支持三种来源：文件选择、剪贴板粘贴、拖拽；本期不做内置截图 |
| O-4  | 检测后处理 v1 采用轴对齐矩形 + 外扩简化方案，不支持大角度旋转/竖排文本 |
| O-5  | 模型 Session 常驻进程，空闲超时（默认 5 分钟）后卸载释放内存 |

# 1 功能概述

## 1.1 功能定位

用户将图片（截图、照片、扫描件）中的文字提取为可编辑文本，直接进入编辑流程。定位为编辑器的「内容入口」能力，与编码转换、列块编辑同级，主界面不新增常驻工具栏按钮，入口收敛到命令面板与快捷键。

## 1.2 用户故事

- 从聊天窗口/网页截图后，`Ctrl+Shift+V` 粘贴 → 2~5s 内弹出识别预览 → 点击「插入」，文本落在光标处；
- 拖拽一张 `.png` 到编辑器 → 弹出菜单选择「提取文字」或「插入图片路径」；
- 识别结果可先在预览面板人工微调，再复制或插入。

## 1.3 非目标（本期不做）

- 不做内置屏幕截图（依赖系统截图工具 + 粘贴入口）；
- 不做竖排文本、艺术字、公式、表格结构还原（表格仅还原为按行空格分隔）；
- 不做手写体识别保证（印刷体为主，手写体仅尽力）；
- 不做批量目录级 OCR。

# 2 方案选型

## 2.1 候选方案对比

| 方案 | 原理 | 体积增量 | 精度 | 集成复杂度 | 结论 |
| ---- | ---- | -------- | ---- | ---------- | ---- |
| A. Python sidecar（paddlepaddle + paddleocr） | 打包 Python 运行时，子进程 HTTP/stdio 通信 | +800MB~1.5GB | 最高 | 中 | 否决，体积目标不允许 |
| B. Paddle-Inference C++ 原生库 | Rust FFI 调 C++ 推理库 | +100~300MB | 最高 | 高（Windows 依赖链复杂） | 否决 |
| C. PP-OCR 模型转 ONNX + Rust `ort` | `paddle2onnx` 转模型，ONNX Runtime CPU 推理 | +35~45MB | 高（与 A 同源模型，mobile 版精度略降） | 中 | **选定** |
| D. Windows 系统自带 OCR（WinRT `Windows.Media.Ocr`） | 系统 API | +0 | 中，依赖系统中文语言包 | 低 | 作为降级备选，不实现（决策 O-1 附注） |
| E. 云端 OCR API | HTTP | +0 | 高 | 低 | 否决：需联网、Key、按量计费 |

## 2.2 选型理由（决策 O-1）

- 与 PaddleOCR 官方 Python 版**同源模型权重**，中文精度接近，仅缺 Paddle 专用优化；
- `ort` crate（ONNX Runtime 官方 Rust 绑定）成熟稳定，`download-binaries` 特性自动拉取预编译二进制，规避本地编译；
- 推理全在 Rust 进程内完成，无 sidecar 进程管理、无跨进程序列化；
- 体积代价可控（见第 9 节预算），可通过「模型按需下载」进一步压缩（v2 备选）。

# 3 模型选型与转换步骤

## 3.1 模型清单

| 用途 | 模型 | 输入 | 输出 | 大小 | 必选 |
| ---- | ---- | ---- | ---- | ---- | ---- |
| 文本检测 | ch_PP-OCRv4_det_infer（DBNet） | 1×3×H×W（H/W 为 32 倍数，限 960） | 概率图 1×1×H×W | ~4.7MB | 是 |
| 文本识别 | ch_PP-OCRv4_rec_infer（SVTR/CTC） | 1×3×48×W（W≤320） | 1×T×6625 | ~10.8MB | 是 |
| 方向分类 | ch_ppocr_mobile_v2.0_cls_infer | 1×3×48×192 | 1×2 | ~1.4MB | 否（v1 裁剪，见 3.4） |
| 字典 | ppocr_keys_v1.txt | 6623 行，UTF-8 | — | ~0.1MB | 是 |

> 安装包内路径：`resources/models/ppocrv4_det.onnx`、`resources/models/ppocrv4_rec.onnx`、`resources/models/ppocr_keys_v1.txt`。

## 3.2 转换环境（一次性操作，开发者本机执行，产物入库）

```bash
# 1. Python 环境（建议 3.9/3.10，Paddle 官方兼容区间）
python -m venv ocr-convert && source ocr-convert/bin/activate  # Windows: ocr-convert\Scripts\activate
pip install paddlepaddle==2.6.1 paddleocr paddle2onnx onnxruntime

# 2. 下载官方推理模型
wget https://paddleocr.bj.bcebos.com/PP-OCRv4/chinese/ch_PP-OCRv4_det_infer.tar
wget https://paddleocr.bj.bcebos.com/PP-OCRv4/chinese/ch_PP-OCRv4_rec_infer.tar
wget https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/main/ppocr/utils/ppocr_keys_v1.txt
tar -xf ch_PP-OCRv4_det_infer.tar && tar -xf ch_PP-OCRv4_rec_infer.tar

# 3. 转 ONNX（检测）
paddle2onnx --model_dir ch_PP-OCRv4_det_infer \
  --model_filename inference.pdmodel \
  --params_filename inference.pdiparams \
  --save_file ppocrv4_det.onnx \
  --opset_version 12 \
  --enable_onnx_checker True

# 4. 转 ONNX（识别）
paddle2onnx --model_dir ch_PP-OCRv4_rec_infer \
  --model_filename inference.pdmodel \
  --params_filename inference.pdiparams \
  --save_file ppocrv4_rec.onnx \
  --opset_version 12 \
  --enable_onnx_checker True
```

## 3.3 转换产物验证（Spike 必过项）

1. **数值验证**：用 Python `onnxruntime` 加载转换后模型，与 `paddleocr` 官方推理对同一批测试图（≥10 张，含中文/英文/数字混排、深浅底色、不同字号）对比，要求识别文本一致率 ≥95%、检测框 IoU ≥0.9；
2. **Rust 端复验**：`ort` 加载后跑同一测试集，结果与 Python onnxruntime 一致；
3. **体积核对**：det.onnx ≈4.7MB、rec.onnx ≈10.8MB，超 20% 则改用 PP-OCRv3 模型回退重转（v3 转换命令相同）。

> 已知风险：PP-OCRv4 rec 在低 opset 下历史上出现过算子兼容问题；Spike 若失败，按顺序回退：opset 13 → PP-OCRv3 rec → 全套 PP-OCRv3。字典不变。

## 3.4 方向分类模型裁剪说明

cls 模型用于纠正整行 180° 倒置的截图。v1 判定使用成本（+1.4MB、每行 +1 次推理）大于收益，裁剪（决策 O-4 附带）。v2 若收到「识别结果为乱序字符」反馈再引入。

# 4 系统架构与数据流

## 4.1 模块布局

```
src-tauri/src/
├── commands/
│   └── ocr.rs            # Tauri command：ocr_extract / ocr_release
├── ocr/
│   ├── mod.rs            # 引擎入口、Session 生命周期管理（决策 O-5）
│   ├── preprocess.rs     # 解码、缩放、归一化（det/rec 共用工具）
│   ├── det.rs            # 检测推理 + DBNet 后处理（连通域、外扩、排序）
│   ├── rec.rs            # 行裁剪、识别推理、CTC 解码
│   └── compose.rs        # 行聚合、段落还原、文本组装
└── resources/models/     # 模型与字典（bundle resources）
```

前端：

```
src/
├── ocr/
│   ├── ocrPanel.ts       # 识别结果预览面板（列表 + 复制/插入按钮）
│   └── ocrInput.ts       # 三种入口的事件捕获（paste/drop/dialog）
```

## 4.2 端到端数据流

```
[入口] 文件选择 / Ctrl+Shift+V 粘贴 / 拖拽图片
   │  前端取得 File/Blob → ArrayBuffer → base64
   ▼
invoke("ocr_extract", { image_b64: "...", source: "paste|file|drop" })
   │
   ▼  Rust（spawn_blocking 线程池，不阻塞 UI）
① base64 → bytes → image crate 解码（png/jpg/bmp/webp）
② preprocess：长边缩放至 ≤960、对齐 32 倍数、归一化 NCHW
③ det.onnx 推理 → 概率图 → 阈值 0.3 二值化 → 连通域 → 外接矩形
   → 按 area/perimeter×1.6 外扩（unclip 近似）→ 文本框列表
④ 逐框裁剪原图 → 高 48、宽按比例 ≤320 右侧补零 → 归一化
⑤ rec.onnx 逐行推理 → CTC 贪心解码 → 查字典 → 行文本 + 置信度
⑥ compose：按框 y 中心聚类成行 → 行内按 x 排序 → 段落间距还原
   ▼
emit("ocr://progress", { stage, pct })   ← ③④⑤ 各阶段推送
   ▼
返回 OcrResult { lines: [{ text, confidence, bbox }], plain_text, elapsed_ms }
   │
   ▼  前端预览面板（用户可编辑微调）
   ├─ 「插入」→ 编辑器光标处插入 plain_text（走既有插入通道，入撤销栈）
   ├─ 「复制」→ tauri-plugin-clipboard-manager 写剪贴板
   └─ Esc / 关闭 → 丢弃
```

# 5 Rust 端详细设计

## 5.1 依赖变更（`src-tauri/Cargo.toml`）

```toml
[dependencies]
ort = { version = "2", features = ["download-binaries"] }  # ONNX Runtime，含 CPU EP
image = { version = "0.25", default-features = false,
          features = ["png", "jpeg", "bmp", "webp"] }
ndarray = "0.16"        # 张量容器（可选，用 Vec<f32> 亦可，以 Spike 实测为准）
```

`package.json` / `capabilities`：

- 新增 `tauri-plugin-clipboard-manager`（「复制」按钮）；
- `capabilities/*.json` 增补 `clipboard-manager:allow-write-text` 权限。

## 5.2 Session 生命周期（决策 O-5）

- 首次 `ocr_extract` 时懒加载两个 Session（det/rec）+ 读取字典进内存，常驻；
- 全局 `last_used: Instant`，空闲 ≥5 分钟后下次调用前先 `drop` 释放（惰性卸载，不挂后台定时器，与主文档「不引入后台线程常驻」原则一致）；
- 提供 `ocr_release` command 供「关于/设置」面板手动释放，用于验收内存回落指标。

## 5.3 检测后处理（`det.rs`，决策 O-4）

1. 概率图（输入同尺寸或 /1 输出，Spike 确认 stride）→ `>0.3` 二值化；
2. 连通域标记：4 邻域 flood fill（自实现，避免引入 imageproc 全量依赖）；
3. 每个连通域取轴对齐外接矩形；**过滤**：宽 <8px 或高 <8px 或面积 <100px 视为噪声；
4. unclip 外扩：`offset = area / perimeter * 1.6`（DB 论文 unclip ratio 1.5~2.0 取中），对矩形四边等距外扩后 clamp 到图内；
5. 输出框按「y 中心分组 → x 排序」预处理排序，供 5.5 使用。

> 限制：轴对齐方案对 ±15° 内倾斜文本可用（外扩矩形覆盖后裁剪略有噪边，识别仍准）；大角度旋转/竖排文本不保证（1.3 非目标）。

## 5.4 识别解码（`rec.rs`）

- 输出 `(1, T, 6625)`，CTC 贪心：逐帧 argmax → **跳过 blank(index 0)** → 相邻重复折叠 → `6624` 映射空格、其余 `idx-1` 查字典（字典 0 起始，CTC 类别 1 起始，偏移 1，**此处为高频出错点，Spike 用固定样例校验**）；
- 行置信度 = 各帧 argmax 概率均值，低于 0.5 的行在预览面板标黄提示人工核对；
- 单行宽 >320px 时按 320 截断的替代方案：**不截断**，等比压缩到 320（失真换完整性，中文小字实测可用，Spike 验证）。

## 5.5 文本组装（`compose.rs`）

- 行聚类：框 y 中心差 < 行高中位数 ×0.6 归入同一行；
- 行内拼接：相邻框水平间隙 > 字宽中位数 ×1.5 时补一个空格（还原中英文混排间距），否则直接连接；
- 段落还原：行间距 > 行高 ×1.8 时插入空行；行首缩进 >2 字宽时行首保留 4 空格；
- `plain_text` 统一 `\n` 换行，插入编辑器时沿用该文件既有换行符（走主文档「换行符保留」规则）。

## 5.6 Tauri Command 签名

```rust
#[derive(Serialize)] struct OcrLine { text: String, confidence: f32, bbox: [u32; 4] }
#[derive(Serialize)] struct OcrResult { lines: Vec<OcrLine>, plain_text: String, elapsed_ms: u64 }

#[tauri::command]
async fn ocr_extract(app: AppHandle, image_b64: String) -> Result<OcrResult, String>
// 输入限制：base64 解码后 ≤20MB；解码失败/格式不支持 → Err("OCR_E_DECODE: ...")
// 错误码前缀：OCR_E_DECODE / OCR_E_MODEL / OCR_E_INFER / OCR_E_TIMEOUT(单图 >15s 主动中止)

#[tauri::command]
async fn ocr_release(app: AppHandle) -> Result<(), String>
```

进度事件负载：`{ stage: "decode|detect|recognize|compose", pct: 0-100 }`，前端状态栏复用既有进度显示位。

# 6 前端设计

## 6.1 入口与快捷键

| 入口 | 触发 | 说明 |
| ---- | ---- | ---- |
| 命令面板 | 「图片文字提取…」 | 打开文件选择器（复用 dialog 插件，filter 限定 png/jpg/bmp/webp） |
| 快捷键 | `Ctrl+Shift+V` | 剪贴板图片识别；**与快捷键总表冲突时改 `Alt+O`，实现前对齐附录 A** |
| 拖拽 | 图片文件拖入编辑器 | 弹菜单：「提取文字 / 插入图片路径 / 取消」 |
| 粘贴兜底 | `Ctrl+V` 粘贴的是图片而非文本 | 提示「检测到图片，按 Ctrl+Shift+V 识别文字」气泡，不打断粘贴本身 |

## 6.2 预览面板（`ocrPanel.ts`）

- 位置：右侧临时面板（复用现有面板容器机制，与 Markdown 预览/搜索面板同级，不新增面板框架）；
- 内容：识别行列表（低置信度行标黄）+ 底部按钮「插入」「复制」「关闭」；列表区可直接编辑，改动实时同步 `plain_text`；
- 插入语义：多光标/选区存在时替换选区，否则插入光标处；单次撤销块（`dispatch` 包一个 `annotate` 事务）；
- 关闭即丢弃结果，不落盘、不进会话恢复。

# 7 配置设计

```jsonc
// settings.json 新增段（无该段时用默认值，兼容既有配置加载）
"ocr": {
  "engine": "paddle-onnx",        // 预留，v1 仅此值
  "idleUnloadMinutes": 5,          // 决策 O-5
  "minConfidence": 0.5,            // 低于此值预览标黄
  "maxImageMB": 20                 // 超限直接报错
}
```

# 8 体积与性能预算

## 8.1 体积（安装包，Windows NSIS）

| 项 | 增量 |
| ---- | ---- |
| onnxruntime.dll（CPU，release strip 后） | ~15~20MB |
| ppocrv4_det.onnx | ~4.7MB |
| ppocrv4_rec.onnx | ~10.8MB |
| 字典 + Rust 代码增量 | <0.5MB |
| **合计** | **~31~36MB → 安装包预估 45~50MB** |

> 决策 O-2 放宽指标为 <55MB；主文档 v1.4 修订时同步更新「安装包 <15MB」口径为「核心编辑器 <15MB，含 OCR 组件 <55MB」。若评审不接受放宽，替代路径：模型改首次使用下载（安装包回到 ~25MB，onnxruntime 仍需分发）或方案 D（WinRT，零体积但精度降级）——**需评审明确选择**。

## 8.2 性能（基准：i5-12500 / 16GB / 1080p 截图，与主文档基准环境口径一致）

| 阶段 | 预算 |
| ---- | ---- |
| 解码 + 预处理 | <200ms |
| 检测推理 + 后处理 | 0.3~0.8s |
| 识别（≤20 行） | 1~2.5s |
| 端到端 | **<4s（P95 <6s）** |
| 模型常驻内存 | +90~130MB（仅加载后；空闲卸载后回落） |

> 内存指标冲突说明：主文档「空闲内存 <120MB」的口径为**启动后未使用大功能**状态；OCR 模型加载后短暂超出属预期，卸载后回落。此口径修订需在主文档 v1.4 同步声明。

# 9 风险与对策

| # | 风险 | 等级 | 对策 |
| ---- | ---- | ---- | ---- |
| 1 | paddle2onnx 转换算子不兼容（rec 模型高发） | 中 | 3.3 Spike 首日验证；回退链 opset13 → v3 rec → 全套 v3 |
| 2 | `ort` 预编译二进制下载失败/被墙 | 中 | `download-binaries` 失败时本地放置 onnxruntime.dll，Cargo 配置 `ORT_LIB_LOCATION`；产物入库 git-lfs |
| 3 | CTC 字典偏移实现错误导致全乱码 | 低 | 5.4 标注校验点，Spike 用「单字符图片→单字符输出」样例先行验证 |
| 4 | 模型常驻内存与空闲指标冲突 | 中 | 决策 O-5 惰性卸载 + 8.2 口径修订 |
| 5 | 大图（4000px+ 照片）推理超时 | 低 | 预处理强制缩至 960；`OCR_E_TIMEOUT` 15s 上限；提示裁剪后重试 |
| 6 | 体积指标评审不通过 | 中 | 8.1 列出三条替代路径，评审会上决断，不阻塞其他功能开发 |
| 7 | WebView 粘贴图片事件兼容性（Windows WebView2） | 低 | paste 事件拿不到图时降级为「保存后从文件入口识别」提示 |

# 10 开发计划（约 8~9 天，可与其他功能并行穿插）

| 阶段 | 内容 | 工期 |
| ---- | ---- | ---- |
| Spike | 模型转换 + 3.3 三项验证（Python 侧） | 0.5 天 |
| 推理核心 | preprocess / det / rec / compose 四模块 + 单元测试（构造合成图样例） | 3.5 天 |
| 接入层 | ocr command、进度事件、Session 生命周期、错误码 | 1 天 |
| 前端 | 三入口、预览面板、剪贴板插件、快捷键对齐 | 2 天 |
| 联调与调优 | 真实截图测试集（中文/英文/代码截图各 10 张）、阈值调参、内存验收 | 1.5 天 |

依赖关系：Spike 通过后再启动推理核心；前端可与推理核心并行。

# 11 验收清单

- [ ] Spike 三项验证通过（一致率 ≥95%、Rust 复验一致、体积达标）；
- [ ] 三入口均可达：命令面板、`Ctrl+Shift+V`、拖拽；
- [ ] 1080p 中文/英文/数字混排截图，端到端 <4s（基准机）；
- [ ] 「插入」结果在撤销栈内一步可撤销，换行符遵循目标文件格式；
- [ ] 「复制」写入系统剪贴板，外部程序粘贴验证；
- [ ] 低置信度行预览面板标黄可编辑；
- [ ] 非图片/超大图/损坏图返回明确错误码与提示语；
- [ ] 空闲 5 分钟后内存回落至未加载水平（任务管理器复测）；
- [ ] 命令面板、状态栏、快捷键总表三处文档同步更新（主文档 v1.4）。
