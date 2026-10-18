// 阻止 Windows release 构建时弹出控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    my_editor_lib::run()
}
