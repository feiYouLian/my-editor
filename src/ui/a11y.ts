/**
 * 无障碍基础设施：屏幕阅读器播报通道。
 *
 * 状态栏的瞬时消息 3 秒后从界面上消失，读屏用户完全拿不到这些反馈
 * （保存成功、Git 失败、跟随暂停……）。这里用一个 aria-live 区域镜像播报。
 */

let region: HTMLElement | null = null;

function ensureRegion(): HTMLElement {
  if (region && region.isConnected) return region;
  const node = document.createElement("div");
  node.className = "a11y-live";
  node.setAttribute("role", "status");
  node.setAttribute("aria-live", "polite");
  node.setAttribute("aria-atomic", "true");
  document.body.append(node);
  region = node;
  return node;
}

/**
 * 播报一条消息（不打断用户当前朗读：politeness=polite）。
 * 同样文本连续出现两次也要能再次播报，所以先清空再于下一帧写入。
 */
export function announce(text: string): void {
  if (!text) return;
  const node = ensureRegion();
  node.textContent = "";
  requestAnimationFrame(() => {
    if (node.isConnected) node.textContent = text;
  });
}
