# 材料库文件夹

`materials.json` 是二维有限元程序的材料库主文件，保存材料颜色和常用力学属性。

`materials.js` 是同一份数据的浏览器备用加载文件，由 `server.js` 自动同步生成。

通过项目根目录的 `start.bat` 或 `node server.js` 打开程序后，界面中的“保存材料”和“删除材料”会直接改写 `materials.json`。
