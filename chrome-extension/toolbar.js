(() => {
    if (globalThis.VisualQAToolbar) return;
    function node(tag, text, parent, attributes = {}) {
        const element = document.createElement(tag);
        if (text !== undefined) element.textContent = text;
        for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
        parent?.append(element); return element;
    }
    const css = `
        :host { all: initial; }
        * { box-sizing: border-box; }
        .panel { display: flex; flex-direction: column; width: 100%; height: 100vh; color: #253248; background: #fff; overflow: hidden; font: 12px/1.55 -apple-system, BlinkMacSystemFont, sans-serif; color-scheme: light; }
        header { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; background: #f0f4ff; border-bottom: 1px solid #dce4f1; }
        strong { font-size: 14px; }
        .body { flex: 1; min-height: 0; padding: 12px 14px; overflow-y: auto; overscroll-behavior: contain; }
        p { margin: 0 0 8px; overflow-wrap: anywhere; }
        .name { font-weight: 650; }
        .muted { font-size: 11px; color: #64738a; }
        .row { display: flex; align-items: center; gap: 8px; margin: 8px 0; }
        .row > * { flex: 1; min-width: 0; }
        .check { display: flex; align-items: center; gap: 5px; font-weight: 500; }
        .check input { width: auto; }
        label { display: block; margin-top: 8px; font-size: 11px; font-weight: 650; }
        input, select, button { font: inherit; color: inherit; }
        input:not([type=checkbox]):not([type=range]), select { width: 100%; min-width: 0; border: 1px solid #c6d2e3; border-radius: 5px; padding: 6px; margin-top: 4px; background: #fff; }
        input[type=range] { display: block; width: 100%; accent-color: #3656d4; margin: 9px 0; }
        input[type=checkbox] { accent-color: #3656d4; }
        button { padding: 6px 9px; border: 1px solid #cad4e3; border-radius: 5px; background: #fff; cursor: pointer; }
        button:hover { background: #edf2ff; }
        button:disabled { opacity: .5; cursor: default; }
        button.primary { width: 100%; padding: 9px; background: #3656d4; color: #fff; border-color: #3656d4; }
        .status { margin-top: 9px; font-size: 11px; color: #35588e; white-space: pre-line; }
        .warning { border-radius: 5px; background: #fff2df; color: #80500b; padding: 7px; }
        .group { border-top: 1px solid #e1e7ef; padding-top: 10px; margin-top: 12px; }
        .tabs { display: flex; gap: 4px; margin: 12px 0; border-bottom: 1px solid #dce4f1; }
        .tabs button { flex: 1; border: 0; border-radius: 5px 5px 0 0; padding: 9px 4px; color: #64738a; }
        .tabs button[aria-selected=true] { color: #274ac4; background: #edf2ff; box-shadow: inset 0 -2px #3656d4; font-weight: 650; }
        .finding-list { list-style: none; margin: 8px 0 0; padding: 0; max-height: 36vh; overflow-y: auto; overscroll-behavior: contain; }
        .finding-list li + li { margin-top: 6px; }
        .finding-item { display: block; width: 100%; padding: 9px; text-align: left; overflow-wrap: anywhere; }
        .finding-item[aria-pressed=true] { border-color: #3656d4; background: #edf2ff; box-shadow: inset 3px 0 #3656d4; }
        .finding-item strong { display: block; font-size: 12px; }
        .finding-item span { display: block; margin-top: 3px; color: #64738a; font-size: 11px; }
        [hidden] { display: none !important; }
        :focus-visible { outline: 2px solid #4166e0; outline-offset: 2px; }
    `;
    function create(meta, settings, invoke) {
        const host = document.createElement('visualqa-tools');
        host.setAttribute('data-visualqa-extension', 'tools');
        host.style.cssText = 'display:block;height:100%;';
        const shadow = host.attachShadow({mode: 'closed'});
        const sheet = new CSSStyleSheet(); sheet.replaceSync(css); shadow.adoptedStyleSheets = [sheet];
        const panel = node('aside', undefined, shadow, {class: 'panel', 'aria-label': '시안 검수 도구'});
        const header = node('header', undefined, panel);
        const version = chrome.runtime.getManifest().version;
        node('strong', `시안 검수 · v${version}`, header, {'data-tool': 'extension-version'});
        const manage = node('button', '검수 파일', header, {type: 'button', 'data-tool': 'manage'});
        const body = node('div', undefined, panel, {class: 'body'});
        node('p', `${meta.device.toUpperCase()} · ${meta.name}`, body, {class: 'name'});
        node('p', `시안 원본 ${meta.width} × ${meta.height}px · 검수 표시 폭 ${meta.display.width}px`, body, {class: 'muted'});
        const tabs = node('div', undefined, body, {class: 'tabs', role: 'tablist', 'aria-label': '검수 도구'});
        const optionsTab = node('button', '검수 옵션', tabs, {type: 'button', role: 'tab', id: 'options-tab', 'aria-controls': 'options-panel', 'aria-selected': 'true', 'data-tool': 'options-tab'});
        const findingsTab = node('button', '차이 항목 · 요소 선택', tabs, {type: 'button', role: 'tab', id: 'findings-tab', 'aria-controls': 'findings-panel', 'aria-selected': 'false', tabindex: '-1', 'data-tool': 'findings-tab'});
        const options = node('section', undefined, body, {role: 'tabpanel', id: 'options-panel', 'aria-labelledby': 'options-tab'});
        const differences = node('section', undefined, body, {role: 'tabpanel', id: 'findings-panel', 'aria-labelledby': 'findings-tab', hidden: ''});
        node('p', '화면 폭에 따라 PC·MO 시안 하나만 표시합니다.', options, {class: 'muted'});
        const variantControls = {};
        for (const device of ['pc', 'mo']) {
            const label = node('label', `${device.toUpperCase()} 시안`, options);
            const select = node('select', undefined, label, {'data-tool': `variant-${device}`});
            node('option', '미등록 · 이 화면에서는 오버레이 숨김', select, {value: ''});
            for (const review of meta.availableReviews) node('option', `${review.name} · ${review.viewportWidth}px`, select, {value: review.id});
            variantControls[device] = select;
        }
        const breakpointLabel = node('label', 'PC 전환 폭 (px) · 이 값 이상이면 PC', options);
        const breakpoint = node('input', undefined, breakpointLabel, {type: 'number', min: '320', max: '4096', step: '1', 'data-tool': 'breakpoint'});
        const applyVariants = node('button', '시안 분기 적용', options, {type: 'button', 'data-tool': 'apply-variants'});
        applyVariants.style.marginTop = '8px';
        const missing = node('p', '', options, {class: 'warning', 'data-tool': 'missing-variant', hidden: ''});
        const visibleLabel = node('label', undefined, options, {class: 'check'});
        const visible = node('input', undefined, visibleLabel, {type: 'checkbox', 'data-tool': 'visible'});
        node('span', '시안 원본 표시', visibleLabel);
        const opacityLabel = node('label', '불투명도', options);
        const opacityText = node('span', ' 40%', opacityLabel);
        const opacity = node('input', undefined, options, {type: 'range', min: '0', max: '100', 'data-tool': 'opacity'});
        const coordinates = node('div', undefined, options, {class: 'row'}), controls = {visible, opacity};
        for (const [name, title, minimum, maximum] of [['dx', 'X 이동 (px)', -150000, 150000], ['dy', 'Y 이동 (px)', -150000, 150000], ['scale', '배율 (%)', 10, 400]]) {
            const label = node('label', title, coordinates);
            controls[name] = node('input', undefined, label, {type: 'number', min: String(minimum), max: String(maximum), 'data-tool': name});
        }
        const resets = node('div', undefined, options, {class: 'row'});
        const reset = node('button', '위치·배율 초기화', resets, {type: 'button', 'data-tool': 'reset'});
        const viewport = node('p', '', options, {class: 'muted', 'data-tool': 'viewport'});
        const rendererVersion = node('p', '', options, {class: 'muted', 'data-tool': 'renderer-version'});
        const mismatch = node('p', '', body, {class: 'muted warning', hidden: ''});
        node('p', `차이 항목 ${meta.findings.length}개`, differences, {class: 'name'});
        const findings = node('ul', undefined, differences, {class: 'finding-list', 'data-tool': 'findings', 'aria-label': '차이 항목 목록'});
        let selectedIndex = meta.findings.length ? 0 : -1;
        const findingButtons = meta.findings.map((finding, index) => {
            const item = node('li', undefined, findings);
            const button = node('button', undefined, item, {type: 'button', class: 'finding-item', 'data-finding-id': finding.id, 'aria-pressed': String(index === selectedIndex)});
            node('strong', `${index + 1}. ${finding.title}`, button);
            node('span', `Y ${Math.round(finding.rect.y)}px · ${Math.round(finding.rect.width)} × ${Math.round(finding.rect.height)}px · 관련 요소 ${finding.selectors.length}개`, button);
            button.addEventListener('click', () => chooseFinding(index, true));
            return button;
        });
        if (!meta.findings.length) node('p', '검출된 차이 항목이 없습니다.', differences, {class: 'muted'});
        const navigation = node('div', undefined, differences, {class: 'row'});
        const previous = node('button', '이전', navigation, {type: 'button', 'data-tool': 'previous'});
        const jump = node('button', '위치 이동', navigation, {type: 'button', 'data-tool': 'jump'});
        const next = node('button', '다음', navigation, {type: 'button', 'data-tool': 'next'});
        const selectedTitle = node('p', '', differences, {class: 'name', 'data-tool': 'selected-finding'});
        const selectors = node('select', undefined, differences, {'data-tool': 'selectors', 'aria-label': '관련 요소'});
        const inspect = node('button', '개발자도구에서 요소 선택', differences, {type: 'button', 'data-tool': 'inspect'});
        inspect.style.cssText = 'width:100%;margin-top:8px;';
        const saving = node('div', undefined, body, {class: 'group'});
        const devtools = node('p', '⌘⌥I로 Chrome 개발자도구를 열어 주세요.', saving, {class: 'muted'});
        const saveLabel = node('label', undefined, saving, {class: 'check'});
        const saveAs = node('input', undefined, saveLabel, {type: 'checkbox', 'data-tool': 'save-as'});
        node('span', '저장 위치 선택', saveLabel);
        const exportButton = node('button', '수정한 HTML·CSS 저장', saving, {type: 'button', class: 'primary', 'data-tool': 'export'});
        exportButton.style.marginTop = '9px';
        const status = node('p', '시안 원본을 겹쳐 보고 Elements에서 수정하세요.', body, {class: 'status', role: 'status', 'data-tool': 'status'});
        const remove = node('button', '검수 도구 연결 해제', body, {type: 'button', 'data-tool': 'remove'});
        let current = {...settings}, ready = false, timer, destroyed = false, dirty = false, sequence = 0, variantsDirty = false;
        function say(text, error = false) { status.textContent = text; status.classList.toggle('warning', error); }
        async function action(type, payload = {}, button) {
            if (button) button.disabled = true;
            try { return await invoke(type, payload); }
            catch (error) { say(error.message, true); }
            finally { if (button && !destroyed) { button.disabled = false; updateReady(); } }
        }
        function updateReady() {
            inspect.disabled = !ready || !selectors.options.length;
            exportButton.disabled = !ready;
            devtools.textContent = ready ? '개발자도구 연결됨 · Elements에서 수정 후 저장하세요.' : '⌘⌥I로 Chrome 개발자도구를 열면 요소 선택과 저장이 가능합니다.';
        }
        function selectFinding() {
            selectors.replaceChildren();
            const finding = meta.findings[selectedIndex];
            for (const [index, button] of findingButtons.entries()) button.setAttribute('aria-pressed', String(index === selectedIndex));
            selectedTitle.textContent = finding ? finding.title : '';
            for (const [index, selector] of (finding?.selectors || []).entries()) node('option', selector, selectors, {value: String(index)});
            previous.disabled = next.disabled = jump.disabled = !finding;
            updateReady();
        }
        function chooseFinding(index, move) {
            selectedIndex = index; selectFinding();
            findingButtons[index]?.scrollIntoView({block: 'nearest'});
            if (move && meta.findings[index]) action('jump', {findingId: meta.findings[index].id});
        }
        function selectTab(tab) {
            const showOptions = tab === optionsTab;
            options.hidden = !showOptions; differences.hidden = showOptions;
            for (const item of [optionsTab, findingsTab]) {
                item.setAttribute('aria-selected', String(item === tab)); item.tabIndex = item === tab ? 0 : -1;
            }
        }
        for (const tab of [optionsTab, findingsTab]) {
            tab.addEventListener('click', () => selectTab(tab));
            tab.addEventListener('keydown', event => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                event.preventDefault();
                const next = event.key === 'Home' ? optionsTab : event.key === 'End' ? findingsTab : tab === optionsTab ? findingsTab : optionsTab;
                selectTab(next); next.focus();
            });
        }
        function read() {
            return {...current, visible: visible.checked, opacity: Number(opacity.value) / 100,
                dx: Number(controls.dx.value), dy: Number(controls.dy.value), scale: Number(controls.scale.value) / 100, saveAs: saveAs.checked};
        }
        async function commit() {
            clearTimeout(timer);
            const pending = ++sequence, value = read(); dirty = true;
            const result = await action('settings', {settings: value});
            if (pending === sequence) { current = result?.settings || value; dirty = false; }
            return result;
        }
        function emit() { sequence++; dirty = true; opacityText.textContent = ` ${opacity.value}%`; clearTimeout(timer); timer = setTimeout(commit, 70); }
        for (const input of [...Object.values(controls), saveAs]) input.addEventListener('input', emit);
        manage.addEventListener('click', () => action('manage'));
        for (const input of [...Object.values(variantControls), breakpoint]) input.addEventListener('input', () => { variantsDirty = true; });
        applyVariants.addEventListener('click', async () => {
            const result = await action('responsive', {breakpoint: Number(breakpoint.value),
                variants: {pc: variantControls.pc.value || null, mo: variantControls.mo.value || null}}, applyVariants);
            if (result) { variantsDirty = false; say('반응형 시안 분기를 적용했습니다.'); }
        });
        reset.addEventListener('click', () => { controls.dx.value = 0; controls.dy.value = 0; controls.scale.value = 100; commit(); });
        jump.addEventListener('click', () => action('jump', {findingId: meta.findings[selectedIndex]?.id}, jump));
        for (const [button, direction] of [[previous, -1], [next, 1]]) button.addEventListener('click', () => {
            if (!meta.findings.length) return;
            chooseFinding((selectedIndex + direction + meta.findings.length) % meta.findings.length, true);
        });
        inspect.addEventListener('click', async () => {
            const result = await action('inspect-request', {findingId: meta.findings[selectedIndex]?.id, selectorIndex: Number(selectors.value)}, inspect);
            if (result) say('Elements에서 요소를 선택했습니다.');
        });
        exportButton.addEventListener('click', async () => {
            if (!await commit()) return;
            say('현재 HTML·CSS를 읽고 있습니다.');
            const result = await action('export-request', {}, exportButton);
            if (result) say('수정본 ZIP 저장을 시작했습니다.' + (result.warnings?.length ? '\n' + result.warnings.join('\n') : ''));
        });
        remove.addEventListener('click', () => action('remove', {}, remove));
        function update(value, state) {
            if (!dirty) {
                current = {...value};
                for (const [name, input] of Object.entries(controls)) {
                    if (shadow.activeElement === input) continue;
                    if (name === 'visible') input.checked = current.visible;
                    else input.value = name === 'opacity' || name === 'scale' ? current[name] * 100 : current[name];
                }
                opacityText.textContent = ` ${Math.round(current.opacity * 100)}%`;
                saveAs.checked = current.saveAs;
            }
            if (!variantsDirty && state.binding) {
                breakpoint.value = state.binding.breakpoint;
                for (const device of ['pc', 'mo']) variantControls[device].value = state.binding.variants[device] || '';
            }
            missing.hidden = !state.missingVariant;
            if (state.missingVariant) missing.textContent = `${state.device.toUpperCase()} 시안이 미등록되어 오버레이를 숨겼습니다. 검수 파일에서 PC·MO를 불러온 뒤 해당 시안을 선택하세요.`;
            viewport.textContent = `현재 ${state.device.toUpperCase()} · 화면 ${state.viewportWidth}px · 검수 폭 ${meta.viewportWidth}px · 자동 축소 없음`;
            mismatch.hidden = !state.widthMismatch || state.missingVariant;
            if (state.widthMismatch) mismatch.textContent = `시안은 검수 폭 ${meta.viewportWidth}px를 유지하며 화면 중앙에 표시됩니다. 정확한 비교는 기기 도구 모음에서 같은 폭으로 맞추세요.`;
            const currentRenderer = state.version === version;
            rendererVersion.textContent = currentRenderer ? `페이지 오버레이 v${state.version}` : '이전 오버레이가 남아 있습니다. 검수 파일에서 현재 페이지에 다시 연결하세요.';
            rendererVersion.classList.toggle('warning', !currentRenderer);
            ready = state.devtoolsReady && !state.switching && currentRenderer; updateReady();
        }
        document.getElementById('tools').append(host); selectFinding();
        return {update, destroy() { destroyed = true; clearTimeout(timer); host.remove(); }};
    }
    globalThis.VisualQAToolbar = {create};
})();
