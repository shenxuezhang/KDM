/**
 * 索赔系统配置文件
 * 包含Supabase配置和其他系统配置
 */

// Supabase 配置
const SUPABASE_CONFIG = {
    url: 'https://jqstlzbpzwdjtdcfcazk.supabase.co',
    anonKey: 'sb_publishable_Xz73dFkaejLkmkoiGGm-_A_GkLxMSc8'
};

// 初始化 Supabase 客户端（全局可访问）
let supabaseClient;
if (typeof supabase !== 'undefined') {
    supabaseClient = supabase.createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.anonKey);
    // 确保全局可访问
    if (typeof window !== 'undefined') {
        window.supabaseClient = supabaseClient;
    }
} else {
    console.error("Supabase SDK loading failed. Please check your internet connection.");
    alert("系统初始化失败：Supabase SDK 未加载，请检查网络后刷新页面。");
}

// ============================================
// 表格配置
// ============================================

// 表格行高配置（单位：px）- 统一管理，只需在此处修改即可影响所有相关代码
const TABLE_ROW_HEIGHT = 50;

// 暴露到全局作用域
if (typeof window !== 'undefined') {
    window.TABLE_ROW_HEIGHT = TABLE_ROW_HEIGHT;
}

// 表格列配置
const TABLE_COLUMNS = [
    { key: 'order_no', label: '海外仓单号', minW: '140px', sort: true },
    { key: 'tracking_no', label: '物流运单号', minW: '140px', sort: true },
    { key: 'warehouse', label: '发货仓', minW: '100px', sort: true },
    { key: 'ship_date', label: '发货日期', minW: '110px', sort: true },
    { key: 'sku', label: '订单SKU', minW: '120px', sort: true },
    { key: 'claim_type', label: '索赔类型', minW: '100px', sort: true },
    { key: 'description', label: '问题描述', minW: '200px', sort: false },
    { key: 'val_amount', label: '货物声明价值', minW: '100px', sort: true },
    { key: 'claim_qty', label: '索赔数量', minW: '80px', sort: true, center: true },
    { key: 'claim_total', label: '总赔偿金额', minW: '120px', sort: true },
    { key: 'currency', label: '币种', minW: '60px', sort: false },
    { key: 'process_status', label: '处理状态', minW: '100px', sort: true },
    { key: 'entry_date', label: '申请提交日期', minW: '110px', sort: true },
    { key: 'remarks', label: '备注', minW: '150px', sort: false, hidden: true }
];

// 权限定义
const PERMISSION_DEFINITIONS = [
    { key: 'can_edit', label: '编辑/修改数据', desc: '允许编辑和修改索赔申请数据' },
    { key: 'can_delete', label: '删除数据', desc: '允许删除索赔申请数据' },
    { key: 'can_export', label: '导出 Excel', desc: '允许导出索赔数据到 Excel 文件' },
    { key: 'can_view_money', label: '查看金额字段', desc: '允许查看货物声明价值和赔偿金额' },
    { key: 'can_audit', label: '查看操作日志', desc: '允许查看用户登录日志和操作历史' }
];

// 数据库字段白名单
const DB_ALLOWED_COLUMNS = [
    'id',
    'cust_name', 'contact_name', 'contact_info',
    'order_no', 'tracking_no', 'warehouse', 'ship_date',
    'sku', 'claim_type', 'description', 'val_amount', 'claim_qty',
    'claim_total', 'currency', 'entry_date', 'process_status', 'remarks',
    'attachments',
    'liable_party',
    'claim_ratio'
];

// 将 DB_ALLOWED_COLUMNS 暴露到全局，供其他模块使用
if (typeof window !== 'undefined') {
    window.DB_ALLOWED_COLUMNS = DB_ALLOWED_COLUMNS;
}

// ============================================
// 搜索功能配置
// ============================================

// 搜索模式枚举
const SEARCH_MODE = {
    FUZZY: 'fuzzy',    // 模糊搜索（默认）
    EXACT: 'exact'     // 精确搜索
};

// 搜索字段映射配置（所有可搜索字段及其搜索策略）
const SEARCH_FIELD_MAP = {
    // 基础信息字段
    'order_no': { 
        label: '海外仓单号', 
        type: 'text', 
        searchable: true,
        useTrgm: true  // 使用GIN索引
    },
    'tracking_no': { 
        label: '物流运单号', 
        type: 'text', 
        searchable: true,
        useTrgm: false
    },
    'warehouse': { 
        label: '发货仓', 
        type: 'text', 
        searchable: true,
        useTrgm: false
    },
    'ship_date': { 
        label: '发货日期', 
        type: 'date', 
        searchable: true,
        useTrgm: false
    },
    // 订单信息字段
    'sku': { 
        label: '订单SKU', 
        type: 'text', 
        searchable: true,
        useTrgm: true  // 使用GIN索引
    },
    'claim_type': { 
        label: '索赔类型', 
        type: 'text', 
        searchable: true,
        useTrgm: false
    },
    'description': { 
        label: '问题描述', 
        type: 'text', 
        searchable: true,
        useTrgm: false
    },
    // 客户信息字段
    'cust_name': { 
        label: '客户名称', 
        type: 'text', 
        searchable: true,
        useTrgm: true  // 使用GIN索引
    },
    'contact_name': { 
        label: '联系人', 
        type: 'text', 
        searchable: true,
        useTrgm: false
    },
    'contact_info': { 
        label: '联系方式', 
        type: 'text', 
        searchable: true,
        useTrgm: false
    },
    // 金额信息字段
    'val_amount': { 
        label: '货物声明价值', 
        type: 'number', 
        searchable: true,
        useTrgm: false
    },
    'claim_total': { 
        label: '总赔偿金额', 
        type: 'number', 
        searchable: true,
        useTrgm: false
    },
    'currency': { 
        label: '币种', 
        type: 'text', 
        searchable: true,
        useTrgm: false
    },
    'claim_qty': { 
        label: '索赔数量', 
        type: 'number', 
        searchable: true,
        useTrgm: false
    },
    'claim_ratio': { 
        label: '赔偿比例', 
        type: 'number', 
        searchable: true,
        useTrgm: false
    },
    // 状态信息字段
    'process_status': { 
        label: '处理状态', 
        type: 'text', 
        searchable: true,
        useTrgm: false
    },
    'entry_date': { 
        label: '申请提交日期', 
        type: 'date', 
        searchable: true,
        useTrgm: false
    },
    'remarks': { 
        label: '备注', 
        type: 'text', 
        searchable: true,
        useTrgm: false
    },
    'liable_party': { 
        label: '责任方判定', 
        type: 'text', 
        searchable: true,
        useTrgm: false
    }
};

// 获取所有可搜索字段列表
const SEARCHABLE_FIELDS = Object.keys(SEARCH_FIELD_MAP).filter(key => SEARCH_FIELD_MAP[key].searchable);

// 暴露到全局作用域
if (typeof window !== 'undefined') {
    window.SEARCH_MODE = SEARCH_MODE;
    window.SEARCH_FIELD_MAP = SEARCH_FIELD_MAP;
    window.SEARCHABLE_FIELDS = SEARCHABLE_FIELDS;
}

