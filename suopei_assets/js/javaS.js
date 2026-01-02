/**
 * 严谨版自动化脚本
 * 用于自动填写表单和执行自动化操作
 */
(async function() {
    console.clear();
    console.log("%c >>> 严谨版自动化脚本启动... ", "background: #000; color: #faad14; font-size: 14px; font-weight: bold;");

    // ================= 工具函数 =================
    const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    // 屏幕提示 (红色报错，蓝色提示)
    function showNotification(msg, isError = false) {
        const div = document.createElement('div');
        div.innerText = msg;
        Object.assign(div.style, {
            position: 'fixed', top: '10%', left: '50%', transform: 'translate(-50%, -50%)',
            background: isError ? '#cf1322' : '#096dd9', color: 'white', padding: '15px 30px',
            borderRadius: '8px', zIndex: 999999, fontWeight: 'bold', fontSize: '16px',
            boxShadow: '0 5px 15px rgba(0,0,0,0.3)', pointerEvents: 'none', transition: 'opacity 0.5s'
        });
        document.body.appendChild(div);
        // 报错停留时间长一点(6秒)，普通提示4秒
        setTimeout(() => { div.style.opacity = '0'; setTimeout(()=>div.remove(), 500); }, isError ? 6000 : 4000);
    }

    // 等待人工确认上传
    function waitForUserConfirmation() {
        return new Promise((resolve) => {
            const mask = document.createElement('div');
            Object.assign(mask.style, {
                position: 'fixed', top: 0, left: 0, width: '100%', height: '100%',
                backgroundColor: 'rgba(0,0,0,0.6)', zIndex: 1000000, display: 'flex',
                justifyContent: 'center', alignItems: 'center', flexDirection: 'column',
                backdropFilter: 'blur(3px)'
            });
            mask.innerHTML = `
                <h2 style="color:white; margin-bottom:20px; text-shadow:0 2px 4px black;">👇 步骤：请在系统窗口选择文件 👇</h2>
                <p style="color:#eee; margin-bottom:20px; font-size:14px;">等待页面上显示出文件名后，再点击下方按钮</p>
            `;
            const btn = document.createElement('button');
            btn.innerText = "✅ 文件已显示，继续执行";
            Object.assign(btn.style, {
                padding: '15px 40px', fontSize: '18px', cursor: 'pointer',
                backgroundColor: '#52c41a', color: 'white', border: 'none',
                borderRadius: '50px', fontWeight: 'bold', boxShadow: '0 4px 15px rgba(82,196,26,0.4)'
            });
            btn.onclick = () => { mask.remove(); resolve(); };
            mask.appendChild(btn);
            document.body.appendChild(mask);
        });
    }

    // 根据标题文字查找并输入 (无视 ID 变化)
    async function fillByLabel(labelText, value) {
        console.log(`正在查找题目: "${labelText}" ...`);
        const allQuestions = Array.from(document.querySelectorAll('.question'));
        const targetContainer = allQuestions.find(q => q.innerText.includes(labelText));

        if (!targetContainer) {
            console.warn(`⚠️ 未找到标题包含 "${labelText}" 的题目`);
            return false;
        }

        const input = targetContainer.querySelector('textarea, input');
        if (!input) return false;

        // 视觉定位 & 暴力写入
        input.scrollIntoView({ block: "center" });
        input.style.backgroundColor = "#fff1f0"; 
        input.style.border = "2px solid red"; 

        input.focus();
        input.click();
        await delay(50);

        input.value = '';
        let success = document.execCommand('insertText', false, value);

        if (!success || input.value !== String(value)) {
            const nativeSetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
            if (nativeSetter) nativeSetter.call(input, value);
            else input.value = value;
            input.dispatchEvent(new Event('input', { bubbles: true }));
        }

        await delay(100);
        if (input.value && input.value.includes(String(value))) {
            input.style.backgroundColor = "";
            input.style.border = "2px solid #52c41a"; 
            console.log(`✅ [${labelText}] 写入成功`);
            return true;
        }
        return false;
    }

    // ================= 脚本主流程 =================

    // --- 步骤 1：严格检查“上传文件”按钮 ---
    console.log("正在执行步骤1：检索 '上传文件' 按钮...");

    // 查找包含“上传文件”文字的特定类名元素
    const btnCandidates = Array.from(document.querySelectorAll('.basic-container-module_container__27YR4, .basic-container-module_main__uVWIE'));
    const uploadBtn = btnCandidates.find(div => div.innerText.includes('上传文件'));

    if (uploadBtn) {
        // 存在：点击它
        console.log("✅ 检测到上传按钮，准备点击...");
        // 确保点击的是外层可点击容器
        const clickTarget = uploadBtn.closest('.basic-container-module_container__27YR4') || uploadBtn;
        clickTarget.click();
        
        // 必须的延迟
        await delay(500); 
    } else {
        // 不存在：报错并终止
        console.error("❌ 未找到 '上传文件' 按钮，脚本终止！");
        showNotification("请先手动操作（再填一份）再启动我！", true);
        return; // ★★★ 关键：彻底停止脚本，不执行后面任何代码 ★★★
    }

    // --- 步骤 2：点击“上传本地文件” ---
    console.log("正在执行步骤2：点击 '上传本地文件'...");
    // 这里的菜单是点击步骤1后动态生成的，所以不需要严格校验是否存在，找不到说明步骤1没点开
    const localMenu = document.querySelector('.dui-menu-item');
    if (localMenu && localMenu.innerText.includes('本地')) {
        localMenu.click();
        await delay(500);
    } else {
        console.warn("⚠️ 未找到 '上传本地文件' 菜单，可能步骤1未完全展开或无需此步");
    }

    // --- 步骤 3：人工介入确认 ---
    // 此时系统文件框已弹出，脚本暂停等待
    await waitForUserConfirmation();

    // --- 步骤 4：点击“库内-代发多发” ---
    const radioLabels = Array.from(document.querySelectorAll('.choice-fill-module_radioItem_title__D0gAG'));
    const targetRadio = radioLabels.find(el => el.innerText.includes('库内-代发多发'));
    if (targetRadio) {
        targetRadio.click();
        console.log("✅ 已选择：库内-代发多发");
    }
    await delay(500);

    // --- 步骤 5：获取文件名 ---
    const fileEl = document.querySelector('.FileCore-module_fileName__iX-ZK');
    if (!fileEl) {
        showNotification("❌ 错误：未检测到文件名，脚本停止", true);
        return;
    }
    const cleanFileName = fileEl.innerText.trim().replace(/_\d+$/, '');
    console.log(`📄 文件名: ${cleanFileName}`);

    // 解析 OBS 和 金额
    const regex = /(OBS[a-zA-Z0-9]+)_([\d.]+)/;
    const match = cleanFileName.match(regex);
    let obs = "", money = "";

    if (match) {
        obs = match[1];
        money = (parseFloat(match[2]) * 7.0).toFixed(2);
        showNotification(`解析成功：${obs} / ¥${money}`);
    } else {
        showNotification("⚠️ 文件名格式无法解析，将跳过计算项", true);
    }

    await delay(500);

    // --- 步骤 6：自动填表 (基于文字定位) ---

    // 填写客户代码
    await fillByLabel("客户代码", "1535172");
    await delay(500);

    // 填写公司名称
    await fillByLabel("公司名称", "深圳市信凯源科技有限公司");
    await delay(500);

    if (match) {
        // 填写订单号
        await fillByLabel("订单号", obs);
        
        // 填写索赔金额
        await fillByLabel("索赔金额", money);
        await delay(500);
    }

    console.log("%c >>> 脚本执行完毕 <<< ", "background: green; color: white; padding: 4px;");
    showNotification("🎉 全部步骤执行完毕！");

})();