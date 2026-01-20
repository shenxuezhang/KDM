/**
 * UI模块
 * 处理用户界面相关的所有功能：视图切换、表单处理、模态框、Toast等
 */

// UI状态
let isFormDirty = false;
let editingId = null;
let visibleColumns = JSON.parse(localStorage.getItem('wh_claims_cols')) || TABLE_COLUMNS.map(c => c.key).filter(k => k !== 'remarks');
let currentFilteredData = [];

// 将 visibleColumns 暴露到全局作用域，供HTML中的代码访问
if (typeof window !== 'undefined') {
    // 使用 Object.defineProperty 创建一个代理，确保修改同步
    Object.defineProperty(window, 'visibleColumns', {
        get: function() {
            return visibleColumns;
        },
        set: function(value) {
            visibleColumns = value;
        },
        enumerable: true,
        configurable: true
    });
}

/**
 * 标记表单为已修改
 */
function markFormDirty() {
    isFormDirty = true;
}

/**
 * 初始化主题
 */
function initTheme() {
    if (localStorage.getItem('theme') === 'dark') {
        document.documentElement.classList.add('dark');
    } else {
        document.documentElement.classList.remove('dark');
    }
}

/**
 * 切换深色模式
 */
function toggleDarkMode() {
    document.documentElement.classList.toggle('dark');
    localStorage.setItem('theme', document.documentElement.classList.contains('dark') ? 'dark' : 'light');
}

/**
 * 显示Toast提示
 */
function showToast(message, type = 'success') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    const styles = {
        success: 'bg-emerald-500 text-white',
        error: 'bg-red-500 text-white',
        info: 'bg-blue-600 text-white'
    };
    toast.className = `flex items-center justify-center w-full px-6 py-3 rounded-xl shadow-lg pointer-events-auto transform transition-all duration-300 toast-enter font-bold text-sm gap-3 ${styles[type]}`;
    toast.innerHTML = `<span>${message}</span>`;
    container.appendChild(toast);
    setTimeout(() => {
        toast.classList.remove('toast-enter');
        toast.classList.add('toast-exit');
        toast.addEventListener('animationend', () => toast.remove());
    }, 3000);
}

/**
 * 切换列配置模态框
 */
function toggleColumnModal() {
    document.getElementById('columnModal').classList.toggle('active');
}

/**
 * 渲染列配置模态框
 */
function renderColumnModal() {
    document.getElementById('columnCheckboxes').innerHTML = TABLE_COLUMNS.map(col => `
        <label class="flex items-center space-x-2 p-2 rounded hover:bg-slate-50 dark:hover:bg-slate-700 cursor-pointer">
            <input type="checkbox" value="${col.key}" ${visibleColumns.includes(col.key) ? 'checked' : ''} class="w-4 h-4 text-blue-600 rounded border-slate-300 focus:ring-blue-500">
            <span class="text-sm font-medium text-slate-700 dark:text-slate-300">${col.label}</span>
        </label>
    `).join('');
}

/**
 * 保存列配置
 */
function saveColumns() {
    const checked = Array.from(document.querySelectorAll('#columnCheckboxes input:checked')).map(cb => cb.value);
    if (checked.length === 0) return alert('至少保留一列');
    visibleColumns = checked;
    localStorage.setItem('wh_claims_cols', JSON.stringify(visibleColumns));
    renderTableHeader();
    renderDatabase();
    toggleColumnModal();
}

/**
 * 重置列配置
 */
function resetColumns() {
    visibleColumns = TABLE_COLUMNS.map(c => c.key).filter(k => k !== 'remarks');
    document.querySelectorAll('#columnCheckboxes input').forEach(cb => cb.checked = visibleColumns.includes(cb.value));
    localStorage.setItem('wh_claims_cols', JSON.stringify(visibleColumns));
    renderTableHeader();
    renderDatabase();
}

/**
 * 渲染表头
 */
function renderTableHeader() {
    const checkboxTh = `<th class="erp-th text-center w-12 pl-4">
        <input type="checkbox" id="selectAll" onclick="toggleSelectAll()" class="w-4 h-4 text-emerald-600 rounded border-slate-300 focus:ring-emerald-500 cursor-pointer bg-slate-100 dark:bg-slate-700 dark:border-slate-600">
    </th>`;

    let html = visibleColumns.map(key => {
        const col = TABLE_COLUMNS.find(c => c.key === key);
        const sortIcon = col.sort ? `<span id="sort-icon-${key}" class="ml-1 opacity-30 text-[10px]">↕</span>` : '';
        
        // 复制按钮（仅对海外仓单号和物流运单号列显示）
        let copyBtnHtml = '';
        if (key === 'order_no' || key === 'tracking_no') {
            copyBtnHtml = `
                <button onclick="event.stopPropagation(); copyColumnData('${key}')" 
                        class="ml-1 p-0.5 text-slate-400 hover:text-blue-600 dark:hover:text-blue-400 transition-colors" 
                        title="复制整列数据">
                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"></path>
                    </svg>
                </button>
            `;
        }
        
        return `<th ${col.sort ? `onclick="sortColumn('${key}')"` : ''} class="erp-th ${col.sort ? 'erp-th-sortable' : ''} ${col.center ? 'text-center' : ''} min-w-[${col.minW}]">${col.label}${sortIcon}${copyBtnHtml}</th>`;
    }).join('');
    
    document.getElementById('tableHeaderRow').innerHTML = checkboxTh + html + `<th class="erp-th text-center min-w-[120px] pr-6">操作</th>`;
}

/**
 * 切换子标签（状态筛选）
 * 修复逻辑：点击状态按钮时，强制重置所有其他筛选条件，确保列表数据与按钮统计一致
 * @param {string} status - 状态值：'all' 或中文状态名（'待审核'、'处理中'、'等待赔付'、'已赔付'、'已驳回'）
 */
/**
 * 切换子标签（状态筛选）
 * 修复版：精准筛选，清除干扰
 * @param {string} status - 中文状态名（'待审核'、'处理中'等）
 */
/**
 * 切换子标签（状态筛选）- 修复版
 * 逻辑：点击即重置所有其他条件，只保留当前状态筛选
 * 【焦土政策】彻底清除所有干扰项，只信任数据库返回的结果
 */
function switchSubTab(status) {
    // 1. 设置当前状态
    ListState.filters.status = status;
    
    // 2. 【关键】彻底清空所有干扰条件
    ListState.filters.search = '';
    ListState.filters.searchMode = 'fuzzy';
    ListState.filters.advancedFilters = null; // 清空高级筛选
    // 【清理】advancedSearch 已废弃，但保留清空操作以确保兼容性
    ListState.filters.advancedSearch = null;
    ListState.filters.type = 'all';           // 重置类型

    // 3. 【关键】同步清空 UI 上的输入框（视觉上也重置）
    const inputsToClear = [
        'quickSearch', 
        'quickFilterWarehouse', 
        'quickFilterClaimType',
        'quickFilterShipDateStart', 
        'quickFilterShipDateEnd',
        'quickFilterEntryDateStart', 
        'quickFilterEntryDateEnd',
        'searchInput' // 如果有这个的话
    ];
    inputsToClear.forEach(id => {
        const el = document.getElementById(id);
        if(el) el.value = '';
    });

    // 4. 更新按钮样式（高亮当前选中的按钮）
    document.querySelectorAll('.filter-btn').forEach(btn => {
        // 移除所有高亮
        btn.classList.remove('bg-blue-500', 'text-white', 'hover:bg-blue-600');
        // 恢复默认灰底
        btn.classList.add('bg-gray-100', 'dark:bg-slate-700', 'text-gray-700', 'dark:text-slate-300', 'hover:bg-gray-200', 'dark:hover:bg-slate-600');
    });
    
    // 找到当前点击的按钮并高亮
    // 映射关系：中文状态 -> ID后缀
    const statusMap = {'待审核':'pending','处理中':'processing','等待赔付':'waiting','已赔付':'paid','已驳回':'rejected'};
    const suffix = status === 'all' ? 'all' : statusMap[status];
    const activeBtn = document.getElementById(`tab-${suffix}`);
    
    if (activeBtn) {
        activeBtn.classList.remove('bg-gray-100', 'dark:bg-slate-700', 'text-gray-700', 'dark:text-slate-300', 'hover:bg-gray-200', 'dark:hover:bg-slate-600');
        activeBtn.classList.add('bg-blue-500', 'text-white', 'hover:bg-blue-600');
    }

    // 5. 重置分页到第一页
    ListState.pagination.page = 1;

    // 6. 清除所有缓存（防止读取到旧的内存数据）
    if (typeof window.clearAllCache === 'function') window.clearAllCache();
    
    // 7. 【核心】强制请求数据
    // 参数含义: append=false (不追加), forceRefresh=true (强制刷新)
    if (typeof window.fetchTableData === 'function') {
        window.fetchTableData(false, true); 
    } else {
    }
}

// 暴露到全局，确保 HTML 中的 onclick 能正确调用
if (typeof window !== 'undefined') {
    window.switchSubTab = switchSubTab;
}

/**
 * 【P2-1优化】同步状态筛选按钮样式
 * 统一的工具函数，用于在状态切换和状态恢复时同步更新按钮样式
 * 确保UI状态与数据状态完全一致，减少代码重复，提高可维护性
 * @param {string} status - 状态值：'all' 或中文状态名（'待审核'、'处理中'、'等待赔付'、'已赔付'、'已驳回'）
 */
function syncStatusButtonStyle(status) {
    // 移除所有按钮的激活状态
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.classList.remove('bg-blue-500', 'text-white', 'hover:bg-blue-600');
        btn.classList.add('bg-gray-100', 'dark:bg-slate-700', 'text-gray-700', 'dark:text-slate-300', 'hover:bg-gray-200', 'dark:hover:bg-slate-600');
    });
    
    // 激活当前状态的按钮
    const statusMap = {'待审核':'pending','处理中':'processing','等待赔付':'waiting','已赔付':'paid','已驳回':'rejected'};
    const suffix = status === 'all' ? 'all' : statusMap[status];
    const activeBtn = document.getElementById(`tab-${suffix}`);
    if (activeBtn) {
        activeBtn.classList.remove('bg-gray-100', 'dark:bg-slate-700', 'text-gray-700', 'dark:text-slate-300', 'hover:bg-gray-200', 'dark:hover:bg-slate-600');
        activeBtn.classList.add('bg-blue-500', 'text-white', 'hover:bg-blue-600');
    }
}

// 暴露到全局，供 restorePageState() 调用
if (typeof window !== 'undefined') {
    window.syncStatusButtonStyle = syncStatusButtonStyle;
}

/**
 * 获取状态徽章HTML
 */
function getStatusBadge(status) {
    const colors = {
        '待审核': 'bg-slate-100 text-slate-600',
        '处理中': 'bg-blue-50 text-blue-600',
        '等待赔付': 'bg-amber-50 text-orange-600',
        '已赔付': 'bg-emerald-50 text-emerald-600',
        '已驳回': 'bg-red-50 text-red-600'
    };
    return `<span class="erp-badge ${colors[status] || colors['待审核']}">${status}</span>`;
}

/**
 * 打开状态编辑模态框
 */
function openStatusModal(id) {
    document.getElementById('statusEditId').value = id;
    document.getElementById('statusModal').classList.add('active');
}

/**
 * 关闭状态编辑模态框
 */
function closeStatusModal() {
    document.getElementById('statusModal').classList.remove('active');
}

/**
 * 更新状态
 */
async function updateStatus(newStatus) {
    const id = document.getElementById('statusEditId').value;
    const index = database.findIndex(i => i.id === id);
    if (index !== -1) {
        const oldStatus = database[index].process_status;
        database[index].process_status = newStatus;
        
        localStorage.setItem('wh_claims_db_pro', JSON.stringify(database));
        
        renderKanban();
        renderDatabase();
        
        const success = await updateDataInSupabase(id, database[index]);
        
        // 强制刷新数据，跳过缓存，确保排序正确，并保持滚动位置
        if (ListState.filters.status !== 'all') {
            if (oldStatus === ListState.filters.status && newStatus !== ListState.filters.status) {
                fetchTableData(false, true, null, true);
            } else if (success) {
                fetchTableData(false, true, null, true);
            }
        } else {
            fetchTableData(false, true, null, true);
        }
        
        // 状态更新后，更新状态统计
        if (typeof updateStatusCounts === 'function') {
            updateStatusCounts();
        }
        
        showToast(`状态更新为：${newStatus}`, 'info');
    }
    closeStatusModal();
}

/**
 * 更新导航状态
 */
function updateNavState(activeView) {
    const items = ['nav-form', 'nav-data', 'nav-kanban', 'nav-notice', 'nav-users', 'nav-login-monitor'];
    items.forEach(id => {
        const el = document.getElementById(id);
        if (id === `nav-${activeView}`) {
            el.className = "flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-bold bg-blue-50 text-blue-600 transition-all cursor-pointer dark:bg-blue-900/20 dark:text-blue-400";
        } else {
            el.className = "flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-bold text-slate-500 hover:bg-slate-50 hover:text-blue-600 transition-all cursor-pointer dark:text-slate-400 dark:hover:bg-slate-800";
        }
    });
}

/**
 * 切换视图
 */
async function switchView(view) {
    // 【内存泄漏修复】清理当前视图的图表
    if (typeof ChartManager !== 'undefined') {
        ChartManager.clear();
    }
    
    await trySwitchView(view);
    
    // 保存当前视图到 localStorage，以便刷新后恢复
    if (typeof localStorage !== 'undefined') {
        localStorage.setItem('wh_claims_currentView', view);
    }
    
    if (view === 'users') {
        // loadUsersFromSupabase 函数在HTML中定义为window.loadUsersFromSupabase
        if (typeof window.loadUsersFromSupabase === 'function') {
            const success = await window.loadUsersFromSupabase();
            if (success) {
                // renderUserManagement 函数也在HTML中定义为window.renderUserManagement
                if (typeof window.renderUserManagement === 'function') {
                    window.renderUserManagement();
                }
            } else {
                // renderUserManagementConnectionError 函数也在HTML中定义为window.renderUserManagementConnectionError
                if (typeof window.renderUserManagementConnectionError === 'function') {
                    window.renderUserManagementConnectionError();
                }
            }
        } else {
            // 函数未定义时，等待一段时间后重试（因为HTML脚本在模块之后加载）
            setTimeout(async () => {
                if (typeof window.loadUsersFromSupabase === 'function') {
                    const success = await window.loadUsersFromSupabase();
                    if (success && typeof window.renderUserManagement === 'function') {
                        window.renderUserManagement();
                    } else if (typeof window.renderUserManagementConnectionError === 'function') {
                        window.renderUserManagementConnectionError();
                    }
                } else {
                    // 显示友好的错误提示
                    const tbody = document.getElementById('usersTableBody');
                    if (tbody) {
                        tbody.innerHTML = '<tr><td colspan="6" class="px-6 py-4 text-center text-red-500">用户管理功能加载失败，请刷新页面重试</td></tr>';
                    }
                }
            }, 200);
        }
    }
    // 注意：'notice' 视图的处理已在 trySwitchView 函数中完成
}

// 将 switchView 暴露到全局作用域，供HTML中的onclick调用
if (typeof window !== 'undefined') {
    window.switchView = switchView;
}

/**
 * 尝试切换视图（带权限检查）
 */
async function trySwitchView(view) {
    if (view === 'users') {
        if (!currentUser || currentUser.role !== 'admin') {
            showToast('权限不足：仅管理员可访问此模块', 'error');
            return;
        }
    }
    if (view === 'login-monitor') {
        if (!currentUser || !hasPermission('can_audit')) {
            showToast('权限不足：仅授权用户可访问登录监控', 'error');
            return;
        }
    }

    // 【修复】检查目标视图是否与当前视图相同，如果相同则跳过 isFormDirty 检查
    // 这样可以避免在页面重新获得焦点时（如切换窗口后回来）触发不必要的确认对话框
    const currentView = localStorage.getItem('wh_claims_currentView') || 'form';
    const isSameView = currentView === view;
    
    // 检查当前视图的 DOM 元素是否可见
    const currentViewEl = document.getElementById(`view-${currentView}`);
    const isCurrentViewVisible = currentViewEl && !currentViewEl.classList.contains('hidden');
    
    // 如果目标视图与当前视图相同且当前视图可见，则跳过 isFormDirty 检查
    if (isSameView && isCurrentViewVisible) {
        // 直接返回，不进行任何检查，也不切换视图
        return;
    }

    // 处理编辑模式下的视图切换
    if (editingId && isFormDirty) {
        if (confirm("您正在编辑数据，是否保存当前修改？")) {
            try {
                const form = document.getElementById('claimForm');
                if (form.checkValidity()) {
                    const record = getFormDataFromInput();
                    const index = database.findIndex(i => i.id === editingId);
                    if (index !== -1) {
                        database[index] = record;
                        await updateDataInSupabase(editingId, record);
                        localStorage.setItem('wh_claims_db_pro', JSON.stringify(database));
                        showToast('数据修改已保存', 'success');
                    }
                } else {
                    showToast('表单验证失败，请检查输入内容', 'error');
                    return;
                }
            } catch (error) {
                showToast('保存失败，请稍后重试', 'error');
                return;
            }
        }
        editingId = null;
        isFormDirty = false;
    } else if (isFormDirty && !confirm("您有未保存的内容，切换后将丢失，是否继续？")) {
        return;
    }
    
    // 清除监控定时器（monitorInterval 在HTML中定义为window.monitorInterval）
    if (typeof window !== 'undefined' && window.monitorInterval) {
        clearInterval(window.monitorInterval);
        window.monitorInterval = null;
    }
    
    // 【修复】切换视图时清除所有复选框的勾选状态
    clearAllCheckboxes();
    
    // 【修复】切换视图时确保批量操作工具栏隐藏
    if (typeof window.updateBatchActionBar === 'function') {
        window.updateBatchActionBar();
    }
    
    updateNavState(view);
    ['view-form', 'view-data', 'view-kanban', 'view-notice', 'view-users', 'view-login-monitor'].forEach(id => {
        document.getElementById(id).classList.add('hidden');
    });
    const target = document.getElementById(`view-${view}`);
    target.classList.remove('hidden');
    target.classList.remove('animate-fade-up');
    void target.offsetWidth;
    target.classList.add('animate-fade-up');
    
    if (view === 'data') {
        // 【修复】切换到数据列表视图时，强制刷新数据（跳过缓存）
        // 确保显示最新的数据，特别是从表单提交后返回列表时
        if (typeof window.fetchTableData === 'function') {
            window.fetchTableData(false, true); // forceRefresh=true 跳过缓存
        } else if (typeof fetchTableData === 'function') {
            fetchTableData(false, true); // forceRefresh=true 跳过缓存
        } else {
            // 如果 fetchTableData 未定义，等待模块加载后重试
            setTimeout(() => {
                if (typeof window.fetchTableData === 'function') {
                    window.fetchTableData(false, true);
                } else if (typeof fetchTableData === 'function') {
                    fetchTableData(false, true);
                } else {
                    // 降级方案：如果 fetchTableData 仍然不可用，只渲染现有数据
                    renderDatabase();
                }
            }, 100);
        }
        setTimeout(initCharts, 50);
    }
    if (view === 'kanban') renderKanban();
    if (view === 'notice') {
        // loadNotices 函数在HTML中定义为window.loadNotices
        // 由于HTML脚本在模块之后加载，需要等待视图完全显示后再调用
        // 使用 requestAnimationFrame 确保DOM已完全渲染
        requestAnimationFrame(() => {
            setTimeout(() => {
                if (typeof window.loadNotices === 'function') {
                    window.loadNotices();
                } else {
                    // 延迟更长时间，确保HTML脚本已加载
                    setTimeout(() => {
                        if (typeof window.loadNotices === 'function') {
                            window.loadNotices();
                        } else {
                            // 显示友好的错误提示
                            const list = document.getElementById('notice-list');
                            if (list) {
                                list.innerHTML = '<div class="text-center py-10"><p class="text-red-500 dark:text-red-400">公告加载功能未初始化，请刷新页面重试</p></div>';
                            }
                        }
                    }, 500);
                }
            }, 100); // 等待100ms确保视图已显示
        });
    }
    if (view === 'login-monitor') {
        // initLoginMonitor 函数在HTML中定义为window.initLoginMonitor
        if (typeof window.initLoginMonitor === 'function') {
            window.initLoginMonitor();
        } else {
            setTimeout(() => {
                if (typeof window.initLoginMonitor === 'function') {
                    window.initLoginMonitor();
                }
            }, 200);
        }
    }
    if (view !== 'form') isFormDirty = false;
    
    if (view === 'form') {
        const form = document.getElementById('claimForm');
        form.reset();
        
        document.getElementById('cust_name').value = "深圳市信凯源科技有限公司";
        document.getElementById('contact_name').value = "沈学章";
        document.getElementById('contact_info').value = "shenxz1989@foxmail.com";
        
        const today = new Date();
        const year = today.getFullYear();
        const month = String(today.getMonth() + 1).padStart(2, '0');
        const day = String(today.getDate()).padStart(2, '0');
        document.getElementById('entry_date').value = `${year}-${month}-${day}`;
        
        editingId = null;
        document.getElementById('submitBtnText').innerText = "确认提交并保存";
        document.getElementById('cancelEditBtn').classList.add('hidden');
        isFormDirty = false;
    }
}

/**
 * 应用筛选条件（增强版：支持搜索模式和防抖）
 */
function applyFilters() {
    const searchInput = document.getElementById('searchInput');
    if (!searchInput) return;
    
    const searchValue = searchInput.value.trim();
    ListState.filters.search = searchValue;
    
    // 保存搜索历史（如果搜索值不为空）
    if (searchValue) {
        saveSearchHistory(searchValue);
    }
    
    // 更新清除按钮显示状态
    const clearBtn = document.getElementById('searchClearBtn');
    if (clearBtn) {
        if (searchValue) {
            clearBtn.classList.remove('hidden');
        } else {
            clearBtn.classList.add('hidden');
        }
    }
    
    ListState.pagination.page = 1;
    fetchTableData();
    
    // 更新搜索结果提示
    updateSearchResultHint();
}

/**
 * 【搜索功能增强】切换搜索模式（模糊/精确）
 */
function toggleSearchMode() {
    const currentMode = ListState.filters.searchMode || 'fuzzy';
    const newMode = currentMode === 'fuzzy' ? 'exact' : 'fuzzy';
    
    ListState.filters.searchMode = newMode;
    
    // 更新UI
    const modeText = document.getElementById('searchModeText');
    const modeToggle = document.getElementById('searchModeToggle');
    
    if (modeText) {
        modeText.textContent = newMode === 'fuzzy' ? '模糊' : '精确';
    }
    
    if (modeToggle) {
        if (newMode === 'exact') {
            modeToggle.classList.remove('bg-blue-100', 'dark:bg-blue-900/30', 'text-blue-700', 'dark:text-blue-400');
            modeToggle.classList.add('bg-purple-100', 'dark:bg-purple-900/30', 'text-purple-700', 'dark:text-purple-400');
        } else {
            modeToggle.classList.remove('bg-purple-100', 'dark:bg-purple-900/30', 'text-purple-700', 'dark:text-purple-400');
            modeToggle.classList.add('bg-blue-100', 'dark:bg-blue-900/30', 'text-blue-700', 'dark:text-blue-400');
        }
    }
    
    // 如果有搜索内容，立即应用
    if (ListState.filters.search) {
        ListState.pagination.page = 1;
        fetchTableData();
        updateSearchResultHint();
    }
}

/**
 * 【搜索功能增强】清除搜索
 */
function clearSearch() {
    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
        searchInput.value = '';
    }
    
    ListState.filters.search = '';
    // 【清理】advancedSearch 已废弃，但保留清空操作以确保兼容性
    ListState.filters.advancedSearch = null;
    // 清空批量搜索
    ListState.filters.batchSearch = null;
    
    // 隐藏清除按钮
    const clearBtn = document.getElementById('searchClearBtn');
    if (clearBtn) {
        clearBtn.classList.add('hidden');
    }
    
    // 【清理】旧的高级搜索面板已删除，无需处理
    
    // 重置搜索模式为模糊
    ListState.filters.searchMode = 'fuzzy';
    const modeText = document.getElementById('searchModeText');
    if (modeText) {
        modeText.textContent = '模糊';
    }
    
    ListState.pagination.page = 1;
    fetchTableData();
    
    // 更新状态统计（重置筛选条件后，统计应反映全部数据）
    if (typeof updateStatusCounts === 'function') {
        updateStatusCounts();
    }
    
    // 隐藏搜索结果提示
    const hint = document.getElementById('searchResultHint');
    if (hint) {
        hint.classList.add('hidden');
    }
}

/**
 * 【清理】旧的高级搜索面板相关函数已删除
 * 这些函数引用的 HTML 元素（advancedSearchPanel、advancedSearchConditions）已不存在
 * 现在使用新的快速筛选系统（quickSearch、quickFilterWarehouse 等）
 */

/**
 * 【搜索功能增强】更新搜索结果提示
 */
function updateSearchResultHint() {
    const hint = document.getElementById('searchResultHint');
    if (!hint) return;
    
    // 检查批量搜索
    const hasBatchSearch = ListState.filters.batchSearch && Array.isArray(ListState.filters.batchSearch) && ListState.filters.batchSearch.length > 0;
    // 检查普通搜索
    const hasSearch = ListState.filters.search && ListState.filters.search.trim();
    
    if (hasBatchSearch && ListState.totalCount !== undefined) {
        const keywordCount = ListState.filters.batchSearch.length;
        const keywordsText = ListState.filters.batchSearch.slice(0, 3).join('、');
        const moreText = keywordCount > 3 ? `等${keywordCount}个关键词` : '';
        hint.innerHTML = `🔍 批量搜索 <span class="font-bold text-blue-600 dark:text-blue-400">${keywordsText}${moreText}</span> - 找到 <span class="font-bold text-emerald-600 dark:text-emerald-400">${ListState.totalCount}</span> 条结果`;
        hint.classList.remove('hidden');
    } else if (hasSearch && ListState.totalCount !== undefined) {
        const searchMode = ListState.filters.searchMode === 'exact' ? '精确' : '模糊';
        const searchText = ListState.filters.search;
        hint.innerHTML = `🔍 <span class="font-bold text-blue-600 dark:text-blue-400">${searchText}</span> (${searchMode}搜索) - 找到 <span class="font-bold text-emerald-600 dark:text-emerald-400">${ListState.totalCount}</span> 条结果`;
        hint.classList.remove('hidden');
    } else {
        hint.classList.add('hidden');
    }
}

// 将搜索相关函数暴露到全局作用域
if (typeof window !== 'undefined') {
    window.toggleSearchMode = toggleSearchMode;
    window.clearSearch = clearSearch;
    // 【清理】旧的高级搜索面板相关函数已删除
    window.updateSearchResultHint = updateSearchResultHint;
}

/**
 * 【搜索功能增强】保存搜索历史（可选功能）
 */
function saveSearchHistory(searchTerm) {
    if (!searchTerm || !searchTerm.trim()) return;
    
    try {
        const history = JSON.parse(localStorage.getItem('search_history') || '[]');
        // 移除重复项
        const filtered = history.filter(item => item !== searchTerm);
        // 添加到开头
        filtered.unshift(searchTerm);
        // 限制最多保存10条
        const limited = filtered.slice(0, 10);
        localStorage.setItem('search_history', JSON.stringify(limited));
    } catch (e) {
        // 保存搜索历史失败，静默处理
    }
}

/**
 * 【搜索功能增强】获取搜索历史
 */
function getSearchHistory() {
    try {
        return JSON.parse(localStorage.getItem('search_history') || '[]');
    } catch (e) {
        return [];
    }
}

/**
 * 排序列
 * 用户点击表头排序时，标记为用户主动设置的排序
 */
function sortColumn(col) {
    if (ListState.sorting.col === col) {
        ListState.sorting.asc = !ListState.sorting.asc;
    } else {
        ListState.sorting.col = col;
        ListState.sorting.asc = true;
    }
    // 标记为用户主动设置的排序
    ListState.sorting.isUserDefined = true;
    ListState.pagination.page = 1;
    fetchTableData();
}

/**
 * 初始化登录表单
 */
function initLoginForms() {
    document.getElementById('login-tab').addEventListener('click', () => showForm('login'));
    document.getElementById('register-tab').addEventListener('click', () => showForm('register'));
    document.getElementById('forgot-password').addEventListener('click', (e) => {
        e.preventDefault();
        showForm('reset');
    });
    document.getElementById('back-to-login').addEventListener('click', () => showForm('login'));
    document.getElementById('login-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        await handleLogin();
    });
    document.getElementById('register-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        await handleRegister();
    });
    document.getElementById('reset-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        await handlePasswordReset();
    });
    
    initPasswordToggle();
}

/**
 * 初始化密码显示/隐藏功能
 */
function initPasswordToggle() {
    const loginPasswordInput = document.getElementById('login-password');
    const loginToggleBtn = document.getElementById('toggle-login-password');
    const registerPasswordInput = document.getElementById('register-password');
    const registerToggleBtn = document.getElementById('toggle-register-password');
    
    function setupPasswordToggle(passwordInput, toggleBtn) {
        toggleBtn.addEventListener('mousedown', () => {
            passwordInput.type = 'text';
        });
        toggleBtn.addEventListener('mouseup', () => {
            passwordInput.type = 'password';
        });
        toggleBtn.addEventListener('mouseleave', () => {
            passwordInput.type = 'password';
        });
        
        toggleBtn.addEventListener('touchstart', (e) => {
            e.preventDefault();
            passwordInput.type = 'text';
        });
        toggleBtn.addEventListener('touchend', (e) => {
            e.preventDefault();
            passwordInput.type = 'password';
        });
    }
    
    if (loginPasswordInput && loginToggleBtn) {
        setupPasswordToggle(loginPasswordInput, loginToggleBtn);
    }
    
    if (registerPasswordInput && registerToggleBtn) {
        setupPasswordToggle(registerPasswordInput, registerToggleBtn);
    }
}

/**
 * 初始化系统标题同步
 */
function initTitleSync() {
    const mainTitle = document.getElementById('system-title-main');
    const secondaryTitle = document.getElementById('system-title-secondary');
    
    if (!mainTitle || !secondaryTitle) return;
    
    function syncTitles() {
        secondaryTitle.textContent = mainTitle.textContent;
    }
    
    syncTitles();
    
    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            if (mutation.type === 'childList' || mutation.type === 'characterData') {
                syncTitles();
            }
        });
    });
    
    observer.observe(mainTitle, {
        childList: true,
        characterData: true,
        subtree: true
    });
}

/**
 * 显示特定表单
 */
function showForm(formType) {
    document.getElementById('login-form').classList.add('hidden');
    document.getElementById('register-form').classList.add('hidden');
    document.getElementById('reset-form').classList.add('hidden');
    document.getElementById(`${formType}-form`).classList.remove('hidden');
    if (formType === 'login' || formType === 'register') {
        document.getElementById('login-tab').className = formType === 'login' ? 'flex-1 py-3 font-bold text-blue-600 border-b-2 border-blue-600' : 'flex-1 py-3 font-bold text-slate-400 hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300';
        document.getElementById('register-tab').className = formType === 'register' ? 'flex-1 py-3 font-bold text-blue-600 border-b-2 border-blue-600' : 'flex-1 py-3 font-bold text-slate-400 hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300';
    }
}

/**
 * 打开图片查看器
 */
function openLightbox(src) {
    const lightbox = document.getElementById('lightbox');
    const img = document.getElementById('lightbox-img');
    img.src = src;
    lightbox.classList.remove('hidden');
    requestAnimationFrame(() => {
        lightbox.classList.remove('opacity-0');
        img.classList.replace('scale-95', 'scale-100');
    });
}

/**
 * 关闭图片查看器
 */
function closeLightbox() {
    const lightbox = document.getElementById('lightbox');
    const img = document.getElementById('lightbox-img');
    lightbox.classList.add('opacity-0');
    img.classList.replace('scale-100', 'scale-95');
    setTimeout(() => lightbox.classList.add('hidden'), 300);
}

/**
 * 全选/反选
 */
function toggleSelectAll() {
    const selectAllBox = document.getElementById('selectAll');
    const rowBoxes = document.querySelectorAll('.row-checkbox');
    rowBoxes.forEach(box => box.checked = selectAllBox.checked);
    // 更新批量操作工具栏
    updateBatchActionBar();
}

/**
 * 更新全选框状态
 */
function updateSelectAllState() {
    const selectAllBox = document.getElementById('selectAll');
    const rowBoxes = document.querySelectorAll('.row-checkbox');
    const checkedBoxes = document.querySelectorAll('.row-checkbox:checked');
    
    if (rowBoxes.length === 0) return;
    
    if (checkedBoxes.length === rowBoxes.length) {
        selectAllBox.checked = true;
        selectAllBox.indeterminate = false;
    } else if (checkedBoxes.length > 0) {
        selectAllBox.checked = false;
        selectAllBox.indeterminate = true;
    } else {
        selectAllBox.checked = false;
        selectAllBox.indeterminate = false;
    }
    
    // 【新增】更新批量操作工具栏显示
    updateBatchActionBar();
}

/**
 * 【修复】清除所有复选框的勾选状态
 */
function clearAllCheckboxes() {
    const selectAllBox = document.getElementById('selectAll');
    const rowBoxes = document.querySelectorAll('.row-checkbox');
    
    // 清除所有行的复选框
    rowBoxes.forEach(box => {
        box.checked = false;
    });
    
    // 清除全选框
    if (selectAllBox) {
        selectAllBox.checked = false;
        selectAllBox.indeterminate = false;
    }
    
    // 【新增】更新批量操作工具栏显示
    updateBatchActionBar();
}

/**
 * 【新增】获取选中行的ID数组
 */
function getSelectedRowIds() {
    const checkedBoxes = document.querySelectorAll('.row-checkbox:checked');
    return Array.from(checkedBoxes).map(cb => cb.value).filter(id => id);
}

/**
 * 【新增】清除选择状态
 */
function clearSelection() {
    clearAllCheckboxes();
}

/**
 * 【新增】获取选中行的ID数组
 */
function getSelectedRowIds() {
    const checkedBoxes = document.querySelectorAll('.row-checkbox:checked');
    return Array.from(checkedBoxes).map(cb => cb.value).filter(id => id);
}

/**
 * 【新增】更新批量操作工具栏显示状态
 * 【修复】确保工具栏在没有选中项时完全隐藏
 */
function updateBatchActionBar() {
    const batchBar = document.getElementById('batch-action-bar');
    const selectedCountEl = document.getElementById('selected-count');
    const selectedCount = getSelectedRowIds().length;
    
    if (!batchBar) return;
    
    if (selectedCount > 0) {
        // 显示工具栏
        batchBar.classList.remove('translate-y-full', 'hidden');
        batchBar.classList.add('translate-y-0');
        batchBar.style.display = 'block';
        if (selectedCountEl) {
            selectedCountEl.textContent = selectedCount;
        }
    } else {
        // 隐藏工具栏 - 使用 translate-y-full 和 hidden 双重保险
        batchBar.classList.remove('translate-y-0');
        batchBar.classList.add('translate-y-full');
        // 确保工具栏完全隐藏（在动画完成后）
        setTimeout(() => {
            if (getSelectedRowIds().length === 0) {
                batchBar.style.display = 'none';
            }
        }, 300); // 与 transition duration 一致
    }
}

// 将函数暴露到全局作用域
if (typeof window !== 'undefined') {
    window.getSelectedRowIds = getSelectedRowIds;
    window.updateBatchActionBar = updateBatchActionBar;
}

/**
 * 渲染看板视图
 */
function renderKanban() {
    const container = document.getElementById('kanban-container');
    const statuses = ['待审核', '处理中', '等待赔付', '已赔付', '已驳回'];
    const dotColors = {
        '待审核': 'bg-slate-400',
        '处理中': 'bg-blue-500',
        '等待赔付': 'bg-amber-500',
        '已赔付': 'bg-emerald-500',
        '已驳回': 'bg-red-500'
    };

    let html = '';
    statuses.forEach(status => {
        const items = database.filter(i => i.process_status === status);
        html += `
        <div class="flex-shrink-0 w-72 bg-slate-100/50 dark:bg-slate-800/50 rounded-2xl border border-slate-200 dark:border-slate-700 flex flex-col max-h-full">
            <div class="p-3 font-bold text-sm text-slate-600 dark:text-slate-300 border-b border-slate-200 dark:border-slate-700 flex justify-between items-center sticky top-0 bg-inherit rounded-t-2xl z-10">
                <div class="flex items-center">
                    <span class="w-1.5 h-1.5 rounded-full mr-2 inline-block ${dotColors[status]}"></span>
                    <span>${status}</span>
                    <span class="ml-2 px-2 py-0.5 bg-white dark:bg-slate-700 rounded-full text-xs">${items.length}</span>
                </div>
            </div>
            <div class="p-2 overflow-y-auto custom-scrollbar flex-1 space-y-2">
                ${items.map(item => `
                    <div class="bg-white dark:bg-slate-700 p-3 rounded-xl border border-slate-200 dark:border-slate-600 shadow-sm hover:shadow-md transition-all cursor-pointer hover:border-blue-300 group" onclick="openStatusModal('${item.id}')">
                        <div class="flex justify-between items-start mb-2">
                            <span class="font-bold text-blue-600 text-xs">${item.order_no}</span>
                            <span class="text-[10px] text-slate-400">${item.entry_date}</span>
                        </div>
                        <div class="text-xs text-slate-600 dark:text-slate-300 mb-2 line-clamp-2">${item.description}</div>
                        <div class="flex justify-between items-center">
                            <span class="text-xs font-mono font-bold text-emerald-600">${item.currency||'$'} ${item.claim_total}</span>
                            <span class="text-[10px] bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded text-slate-500">${item.claim_type}</span>
                        </div>
                    </div>
                `).join('')}
            </div>
        </div>`;
    });
    container.innerHTML = html;
}

/**
 * 导出筛选后的数据
 * 优化：排除 id 列，按照 TABLE_COLUMNS 顺序排列，使用中文表头
 */
function exportFilteredData() {
    const dataToExport = currentFilteredData.length > 0 ? currentFilteredData : [];
    if (dataToExport.length === 0) return showToast('当前没有可导出的数据', 'error');
    
    // 获取表格列配置（排除隐藏列、id列和所属店铺列）
    const exportColumns = (typeof TABLE_COLUMNS !== 'undefined' ? TABLE_COLUMNS : []).filter(col => 
        col.key !== 'id' && !col.hidden && col.key !== 'store_by'
    );
    
    // 构建表头（中文）
    const headers = exportColumns.map(col => col.label);
    
    // 构建数据行，按照 TABLE_COLUMNS 的顺序
    const rows = dataToExport.map(item => {
        return exportColumns.map(col => {
            const value = item[col.key];
            // 日期字段格式化：只显示日期部分
            if ((col.key === 'ship_date' || col.key === 'entry_date') && value) {
                const dateStr = String(value);
                return dateStr.length >= 10 ? dateStr.substring(0, 10) : dateStr;
            }
            return value || '';
        });
    });
    
    // 构建工作表数据：表头 + 数据行
    const wsData = [headers, ...rows];
    
    // 创建工作表
    const ws = XLSX.utils.aoa_to_sheet(wsData);
    
    // 设置列宽（根据内容自动调整）
    const colWidths = exportColumns.map(col => {
        // 计算该列最大宽度
        const maxWidth = Math.max(
            col.label.length + 2, // 表头宽度
            ...rows.map(row => {
                const value = row[exportColumns.indexOf(col)];
                return String(value).length + 2;
            })
        );
        return { wch: Math.min(maxWidth, 50) }; // 限制最大宽度为50
    });
    ws['!cols'] = colWidths;
    
    // 获取所有单元格范围
    const range = XLSX.utils.decode_range(ws['!ref']);
    
    // 遍历所有单元格，设置样式
    for (let r = range.s.r; r <= range.e.r; r++) {
        for (let c = range.s.c; c <= range.e.c; c++) {
            const cellRef = XLSX.utils.encode_cell({ r, c });
            if (!ws[cellRef]) ws[cellRef] = { v: '' };
            
            // 基础样式：全表垂直居中，水平居中
            ws[cellRef].s = {
                alignment: {
                    vertical: 'center',
                    horizontal: 'center',
                    wrapText: true
                },
                border: {
                    top: { style: "thin" },
                    bottom: { style: "thin" },
                    left: { style: "thin" },
                    right: { style: "thin" }
                }
            };
            
            // 第1-2行表头加粗显示
            if (r <= 1) {
                ws[cellRef].s.font = {
                    bold: true
                };
            }
        }
    }
    
    // 创建工作簿并添加工作表
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "索赔清单");
    
    // 导出文件
    XLSX.writeFile(wb, `索赔清单_导出_${new Date().toLocaleDateString()}.xlsx`);
    
    showToast(`成功导出 ${dataToExport.length} 条数据`, 'success');
}

/**
 * 导出单条记录到Excel
 */
function exportSingleExcel(data) {
    const wb = XLSX.utils.book_new();
    const ws_data = [
        [null, "有只熊海外仓索赔申请表", null, null, null, null, null, null],
        [null, "信息类型", "字段名称", "填写内容", "填写方", "公式/验证", null, null, null],
        [null, "客户信息", "客户名称 (公司全称)", data.cust_name, "客户", "必填项", null, null, null],
        [null, null, "联系人", data.contact_name, "客户", "必填项", null, null, null],
        [null, null, "联系方式", data.contact_info, "客户", "必填项", null, null, null],
        [null, "订单信息", "海外仓单号", data.order_no, "客户", "必填项", null, null, null],
        [null, null, "物流运单号", data.tracking_no, "客户", "必填项", null, null, null],
        [null, null, "发货日期", data.ship_date, "客户", "必填项", null, null, null],
        [null, null, "订单SKU", data.sku, "客户", "必填项", null, null, null],
        [null, null, "发货仓", data.warehouse, "客户", "必填项", null, null, null],
        [null, "索赔详情", "索赔类型", data.claim_type, "客户", "必填项", null, null, null],
        [null, null, "问题描述", data.description, "客户", "必填项", null, null, null],
        [null, null, "责任方判定", data.liable_party, "有只熊", "选择项", null, null, null],
        [null, "赔偿计算", "货物声明价值(USD)", "$" + data.val_amount, "客户", "必填项", null, null, null],
        [null, null, "索赔数量", data.claim_qty, "客户", "必填项", null, null, null],
        [null, null, "赔偿比例(%)", data.claim_ratio + "%", "有只熊", "必填项", null, null, null],
        [null, null, "总赔偿金额(USD)", "$" + data.claim_total, "客户", "必填项", null, null, null],
        [null, "其他信息", "附件清单", data.attachments, "客户", "必填项", null, null, null],
        [null, null, "申请提交日期", data.entry_date, "客户", "日期格式", null, null, null],
        [null, null, "处理状态", data.process_status, "客户", "下拉菜单", null, null, null],
        [null, null, "备注", data.remarks, "有只熊", "必填项", null, null, null]
    ];
    const ws = XLSX.utils.aoa_to_sheet(ws_data);
    
    // 修复合并单元格定义，确保所有合并区域正确
    ws['!merges'] = [
        { s: {r: 0, c: 1}, e: {r: 0, c: 4} }, // 标题
        { s: {r: 2, c: 1}, e: {r: 4, c: 1} }, // 客户信息
        { s: {r: 5, c: 1}, e: {r: 9, c: 1} }, // 订单信息
        { s: {r: 10, c: 1}, e: {r: 12, c: 1} }, // 索赔详情
        { s: {r: 13, c: 1}, e: {r: 16, c: 1} }, // 赔偿计算
        { s: {r: 17, c: 1}, e: {r: 20, c: 1} }  // 其他信息
    ];
    
    ws['!cols'] = [{wch: 2}, {wch: 15}, {wch: 25}, {wch: 40}, {wch: 15}];
    
    // 获取所有单元格范围
    const range = XLSX.utils.decode_range(ws['!ref']);
    
    // 遍历所有单元格，设置样式
    for (let r = range.s.r; r <= range.e.r; r++) {
        for (let c = range.s.c; c <= range.e.c; c++) {
            const cellRef = XLSX.utils.encode_cell({ r, c });
            if (!ws[cellRef]) ws[cellRef] = { v: '' };
            
            // 基础样式：全表垂直居中，水平居中
            ws[cellRef].s = {
                alignment: {
                    vertical: 'center',
                    horizontal: 'center',
                    wrapText: true
                },
                border: {
                    top: { style: "thin" },
                    bottom: { style: "thin" },
                    left: { style: "thin" },
                    right: { style: "thin" }
                }
            };
            
            // 第1-2行表头加粗显示
            if (r <= 1) {
                ws[cellRef].s.font = {
                    bold: true
                };
            }
            
            // 确保合并单元格的文本内容被正确保留
            // 对于所有合并区域的左上角单元格，确保文本存在且样式正确
            ws['!merges'].forEach(merge => {
                if (r === merge.s.r && c === merge.s.c) {
                    // 这是合并区域的左上角单元格
                    // 确保它有值
                    if (!ws[cellRef].v && ws_data[r][c]) {
                        ws[cellRef].v = ws_data[r][c];
                    }
                    // 合并区域标题加粗
                    ws[cellRef].s.font = {
                        bold: true
                    };
                }
            });
        }
    }
    
    XLSX.utils.book_append_sheet(wb, ws, "申请表");
    XLSX.writeFile(wb, `索赔单_${data.order_no}_${data.claim_total}.xlsx`);
}

/**
 * 复制到微信格式
 */
function copyToWeChat() {
    const checkboxes = document.querySelectorAll('.row-checkbox:checked');
    if (checkboxes.length === 0) return showToast('请先勾选需要复制的数据行', 'error');

    let clipboardText = "";
    let count = 0;

    checkboxes.forEach((checkbox, index) => {
        const item = database.find(i => i.id === checkbox.value);
        if (item) {
            const entryText = `问题类型：${item.claim_type || ''}
仓库问题：${item.description || ''}
出库单号OWS：${item.order_no || ''}
物流运单号：${item.tracking_no || ''}
产品编码：${item.sku || ''}
数量：${item.claim_qty || ''}
发货日期：${item.ship_date || ''}
索赔金额：${item.claim_total || ''} ${item.currency || ''}
索赔申请表：已提交`;
            clipboardText += entryText + (index < checkboxes.length - 1 ? "\n------------------------\n" : "");
            count++;
        }
    });

    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(clipboardText).then(() => {
            showToast(`成功复制 ${count} 条数据到剪贴板！`, 'success');
        }).catch(err => {
            fallbackCopyTextToClipboard(clipboardText, count);
        });
    } else {
        fallbackCopyTextToClipboard(clipboardText, count);
    }
}

/**
 * 复制列数据
 * 获取当前显示的所有行的指定列数据，用换行符分隔后复制到剪贴板
 * @param {string} columnKey - 列字段名（如 'order_no' 或 'tracking_no'）
 */
function copyColumnData(columnKey) {
    // 获取当前显示的数据
    const currentData = (typeof ListState !== 'undefined' && ListState.data) ? ListState.data : [];
    
    if (currentData.length === 0) {
        showToast('当前没有可复制的数据', 'error');
        return;
    }
    
    // 提取指定列的所有值，过滤空值但保留所有行（包括空值行用空字符串表示）
    const columnValues = currentData.map(item => {
        const value = item[columnKey];
        // 如果值是日期类型，格式化显示
        if (columnKey === 'ship_date' || columnKey === 'entry_date') {
            if (value) {
                // 如果是ISO格式日期，只取日期部分
                const dateStr = String(value);
                return dateStr.length >= 10 ? dateStr.substring(0, 10) : dateStr;
            }
            return '';
        }
        return value || '';
    });
    
    // 用换行符连接所有值
    const clipboardText = columnValues.join('\n');
    
    // 获取列名用于提示
    const colConfig = (typeof TABLE_COLUMNS !== 'undefined') ? 
        TABLE_COLUMNS.find(c => c.key === columnKey) : null;
    const columnLabel = colConfig ? colConfig.label : columnKey;
    
    // 复制到剪贴板
    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(clipboardText).then(() => {
            showToast(`成功复制 ${currentData.length} 条${columnLabel}数据到剪贴板！`, 'success');
        }).catch(err => {
            fallbackCopyColumnData(clipboardText, currentData.length, columnLabel);
        });
    } else {
        fallbackCopyColumnData(clipboardText, currentData.length, columnLabel);
    }
}

/**
 * 兼容性复制列数据函数
 * @param {string} text - 要复制的文本
 * @param {number} count - 数据条数
 * @param {string} columnLabel - 列名
 */
function fallbackCopyColumnData(text, count, columnLabel) {
    var textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.style.top = "0";
    textArea.style.left = "0";
    textArea.style.position = "fixed";
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    try {
        var successful = document.execCommand('copy');
        if(successful) {
            showToast(`成功复制 ${count} 条${columnLabel}数据到剪贴板！`, 'success');
        } else {
            showToast('复制失败，请手动复制', 'error');
        }
    } catch (err) {
        showToast('复制失败，请手动复制', 'error');
    }
    document.body.removeChild(textArea);
}

/**
 * 兼容性复制函数
 */
function fallbackCopyTextToClipboard(text, count) {
    var textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.style.top = "0";
    textArea.style.left = "0";
    textArea.style.position = "fixed";
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();

    try {
        var successful = document.execCommand('copy');
        if (successful) {
            showToast(`成功复制 ${count} 条数据到剪贴板！`, 'success');
        } else {
            showToast('复制失败，请手动复制', 'error');
        }
    } catch (err) {
        showToast('复制失败，请手动复制', 'error');
    }

    document.body.removeChild(textArea);
}

// 将复制列数据函数暴露到全局作用域
if (typeof window !== 'undefined') {
    window.copyColumnData = copyColumnData;
    window.fallbackCopyColumnData = fallbackCopyColumnData;
}

