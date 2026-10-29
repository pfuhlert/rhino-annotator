function execCopy(text: string) {
  const area = Object.assign(document.createElement("textarea"), { value: text });
  area.style.cssText = "position:fixed;opacity:0";
  document.body.append(area);
  area.select();
  document.execCommand("copy");
  area.remove();
}

// navigator.clipboard only exists in secure contexts; plain-http deployments fall back to execCommand.
export function copyText(text: string) {
  if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => execCopy(text));
  else execCopy(text);
}
