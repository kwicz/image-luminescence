// Luminesce: export the selected node as PNG and hand it to the UI,
// which runs the same in-browser Ultra HDR encoder as the website.
figma.showUI(__html__, { width: 340, height: 300 });

async function exportSelection() {
  const sel = figma.currentPage.selection;
  if (sel.length !== 1) {
    figma.ui.postMessage({ type: "status", text: "Select exactly one layer or frame." });
    return;
  }
  const node = sel[0];
  const bytes = await node.exportAsync({
    format: "PNG",
    constraint: { type: "SCALE", value: 2 },
  });
  figma.ui.postMessage({
    type: "image",
    bytes,
    name: node.name.replace(/[^\w-]+/g, "-").toLowerCase() || "layer",
  });
}

figma.ui.onmessage = (msg) => {
  if (msg.type === "export") exportSelection();
  if (msg.type === "done") figma.notify(msg.text);
};

exportSelection();
