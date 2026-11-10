const $ = (id) => document.getElementById(id);
let state;
async function rpc(type, data = {}) {
  const r = await chrome.runtime.sendMessage({
    channel: "BT_BG",
    type,
    ...data,
  });
  if (!r?.ok) throw Error(r?.error?.message || "扩展连接中断");
  return r.data;
}
const el = (tag, text) => {
  const n = document.createElement(tag);
  n.textContent = text;
  return n;
};
const run = async (fn) => {
  try {
    await fn();
  } catch (e) {
    $("status").textContent = e.message;
  }
};
function button(text, fn) {
  const b = el("button", text);
  b.type = "button";
  b.onclick = () => run(fn);
  return b;
}
function render() {
  const type = $("filter").value,
    q = $("search").value.toLowerCase();
  const rows = state.records.filter(
    (r) =>
      (type === "all" ||
        (type === "reading" && !r.learning) ||
        (type === "learning" && r.learning) ||
        (type === "due" && r.learning && r.due <= Date.now())) &&
      (r.text + " " + r.translation).toLowerCase().includes(q),
  );
  $("count").textContent =
    `共 ${state.records.length} 条记录 · 当前显示 ${rows.length} 条`;
  $("records").replaceChildren();
  for (const r of rows) {
    const box = el("article", "");
    box.className = "card";
    box.append(
      el("strong", r.text),
      el(
        "p",
        r.learning
          ? "下次复习：" + new Date(r.due).toLocaleString()
          : "阅读记录",
      ),
    );
    const reveal = () => {
      const content = el("div", "");
      content.append(el("p", r.translation), el("blockquote", r.context));
      if (r.url) {
        const a = el("a", "查看原文来源");
        a.href = r.url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        content.append(a);
      }
      box.append(content);
    };
    if (r.learning) {
      box.append(
        button("回忆后揭晓", () => {
          reveal();
          for (const [label, rating] of [
            ["记得", "remember"],
            ["忘了", "forget"],
            ["跳过", "skip"],
          ])
            box.append(
              button(label, async () => {
                await rpc("LEARN_REVIEW", { id: r.id, rating });
                await refresh();
              }),
            );
          box.querySelector("button").disabled = true;
        }),
      );
    } else reveal();
    box.append(
      button(r.learning ? "暂不复习" : "加入学习", async () => {
        await rpc("LEARN_UPDATE", {
          id: r.id,
          action: r.learning ? "archive" : "learn",
        });
        await refresh();
      }),
      button("删除此条", async () => {
        await rpc("LEARN_UPDATE", { id: r.id, action: "delete" });
        await refresh();
      }),
    );
    $("records").append(box);
  }
  const votes = state.records.reduce(
      (s, r) => s + r.remembered + r.forgotten,
      0,
    ),
    forgot = state.records.reduce((s, r) => s + r.forgotten, 0);
  $("suggestion").textContent =
    votes >= 5
      ? forgot / votes > 0.5
        ? "最近反馈中忘记较多，可以降低学习难度或减少新词；水平不会自动修改。"
        : "已有多次复习反馈。如果文章持续太容易，可试着提高推荐水平；记得次数不等于掌握。"
      : "";
}
async function refresh() {
  state = await rpc("LEARN_GET");
  $("enabled").checked = state.preferences.enabled;
  $("level").value = state.preferences.level;
  $("preference").value = state.preferences.preference;
  render();
}
$("save").onclick = () =>
  run(async () => {
    if (
      $("enabled").checked &&
      !(await chrome.permissions.request({
        origins: ["http://*/*", "https://*/*"],
      }))
    )
      throw Error("网页访问权限未授予，未保存");
    const r = await rpc("LEARN_SET", {
      preferences: {
        enabled: $("enabled").checked,
        level: $("level").value,
        preference: $("preference").value,
      },
    });
    await refresh();
    $("status").textContent =
      "学习设置已保存。" +
      (r.unreachable ? "部分标签页无法接入，普通网页刷新后生效。" : "");
  });
$("filter").onchange = render;
$("search").oninput = render;
$("export").onclick = () =>
  run(async () => {
    const data = await rpc("LEARN_GET");
    const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json",
      }),
      url = URL.createObjectURL(blob),
      a = el("a", "");
    a.href = url;
    a.download =
      "english-learning-" + new Date().toISOString().slice(0, 10) + ".json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    $("status").textContent = "已生成学习库导出文件。";
  });
$("import").onchange = () =>
  run(async () => {
    const file = $("import").files[0];
    if (!file) return;
    if (file.size > 3000000) throw Error("文件超过3MB，请分批整理");
    const data = JSON.parse(await file.text());
    await rpc("LEARN_IMPORT", { data });
    await refresh();
    $("status").textContent = "已合并导入，原有条目的复习进度保留。";
    $("import").value = "";
  });
$("clear").onclick = () =>
  run(async () => {
    if (!confirm("删除本机全部学习记录？建议先导出备份。")) return;
    await rpc("LEARN_CLEAR");
    await refresh();
    $("status").textContent = "学习记录已删除。翻译缓存和连接未改变。";
  });
const quiz = [
  {
    q: "“She usually walks to work.” 描述什么？",
    options: ["一次偶然的散步", "日常习惯", "未来计划"],
    answer: 1,
  },
  {
    q: "“Despite the rain, the match continued.” 哪种理解正确？",
    options: ["比赛因雨取消", "雨停后才开赛", "下雨仍继续比赛"],
    answer: 2,
  },
  {
    q: "“The proposal is plausible, albeit insufficiently substantiated.” 作者的态度是？",
    options: ["完全否定方案", "认为有道理但证据不足", "认为证据已经充分"],
    answer: 1,
  },
];
for (const [i, q] of quiz.entries()) {
  const field = el("fieldset", "");
  field.append(el("legend", q.q));
  for (const [j, o] of q.options.entries()) {
    const label = el("label", o),
      input = document.createElement("input");
    input.type = "radio";
    input.name = "q" + i;
    input.value = j;
    label.prepend(input);
    field.append(label);
  }
  $("placement").append(field);
}
$("placement").append(
  button("查看参考建议", () => {
    const values = quiz.map(
      (_, i) => document.querySelector(`input[name="q${i}"]:checked`)?.value,
    );
    if (values.some((v) => v === undefined)) throw Error("请先回答三题");
    const n = values.filter((v, i) => Number(v) === quiz[i].answer).length;
    $("placement-result").textContent =
      `本次 ${n}/3。可从 ${["A1", "A2", "B1", "B2"][n]} 的示例开始试读，再手动选择适合的水平。这三题不能测定完整英语能力。`;
  }),
);
void run(async () => {
  await refresh();
  $("status").textContent = "学习库已就绪。";
});
