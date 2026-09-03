# 打包成独立 APK - PACKAGING.md

目标形态：脚本作为独立 APK 运行在手机上，不依赖 AutoJs6、不依赖 PC。
PC 只在开发和调试阶段使用。

以下内容全部来自 AutoJs6 6.7.0 上的实测，不是文档推断。

## 流程

```text
npm run project          在 PC 上生成 dist/project/
   ↓ adb push
/sdcard/<项目名>/         手机上的项目目录
   ↓ AutoJs6 文件列表 -> 右侧菜单 -> 打包应用 -> 右下角按钮
build/<名称>_v<版本>.apk  生成的独立 APK
   ↓ 安装
独立运行，无需 AutoJs6
```

打包动作只能在手机上的 AutoJs6 里完成。VSCode 插件提供了新建、保存、运行项目，
但**没有打包命令**，无法从 PC 触发。

## 生成项目目录

```powershell
npm run project
```

产出 `dist/project/`，三部分：

| 内容 | 说明 |
|---|---|
| `main.js` | 打包后的单文件，即 `dist/main-autojs.js` |
| `assets/` | 找图素材，必须与 `main.js` 同级 |
| `project.json` | AutoJs6 项目配置 |

可选参数：`--package`、`--version-name`、`--version-code`、`--libs`、`--abis`、`--run-on-boot`。

## 素材路径必须是相对路径

配置里 `assetsRoot: "./assets"`，由运行时用 `files.path()` 解析为相对当前脚本的位置。

这样同一份配置在两种形态下都成立：开发时脚本与 `assets/` 一起推到设备同一目录，
打包后两者一起进包。**如果写成 `/sdcard/...` 绝对路径，打包后必然找不到素材。**
生成器会拒绝非相对路径的配置。

## project.json 的真实字段

AutoJs6 打包界面会用自己的 schema 回写 `project.json`。以下字段名与取值是实测得到的，
与 VSCode 插件自带模板并不一致（插件模板里的 `optimization.removeOpenCv` 不是真实字段）：

```json
{
    "name": "RXFS",
    "packageName": "com.dsom.macro.rxfs",
    "versionName": "1.0.0",
    "versionCode": 1,
    "main": "main.js",
    "abis": ["arm64-v8a"],
    "libs": ["OpenCV"],
    "assets": [],
    "useFeatures": [],
    "launchConfig": {
        "launcherVisible": true,
        "runOnBoot": false,
        "hideLogs": true,
        "displaySplash": false,
        "splashText": "RXFS"
    },
    "permissions": ["android.permission.FOREGROUND_SERVICE", "..."],
    "signatureScheme": "V1 + V2",
    "ignore": ["build"]
}
```

### libs 是重点

`libs` 控制打进 APK 的支持库，取值是打包界面上的可读名称。**必须包含 `OpenCV`**，
否则 `images.findImage` 会静默失效——不报错，只是永远匹配不到，是最难查的一类故障。
生成器会强制校验这一项。

除 OpenCV 外的库需要**先在 AutoJs6 里安装对应插件**，否则打包直接失败：

```text
打包失败
缺少 "Paddle OCR" 所需的插件. 请先安装插件, 然后重试.
```

将来用例需要 OCR 时，要先在 AutoJs6 的「插件」页装好 OCR 插件，
再用 `--libs "OpenCV,MLKit OCR"` 生成项目。

## 已验证结果

2026-09-03 在神龙云机上完成全链路：

- `dist/project/` 推到 `/sdcard/rxfs-project/`，AutoJs6 文件列表将其识别为项目（蓝色图标）
- 「打包应用」界面正确读取了生成的 `project.json`（应用名、包名、版本、路径全部对上）
- 勾选 OpenCV、ABI 选 arm64-v8a，生成 `RXFS_v1.0.0.apk`，41.9 MB
- 安装为 `com.dsom.macro.rxfs`，启动后**自动执行登录任务，9 步全绿，耗时 69 秒**
- 该云机会自动授予无障碍服务；普通设备需要手动在系统设置里为新 APK 开启

## 尚未解决

**截图授权每次仍需确认一次。** 打包后的 APK 同样要申请 MediaProjection，
Android 10 不允许记住该授权。当前靠人工或 adb 点一次。

无人值守要真正成立，方向是让一个常驻脚本申请一次权限后**在进程内循环执行**，
而不是每次重新拉起脚本。这一点连同 `runOnBoot` 需要一并设计和实测。
