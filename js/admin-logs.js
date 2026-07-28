/* ===========================
   SCHOOLHUB PRO - ADMIN LOGS MANAGER
   مدارس الجيل الجديد الخاصة
   الإصدار: 2.1
   =========================== */

/**
 * وحدة إدارة سجل العمليات - للقراءة فقط
 * تم إصلاحه: #11 - إزالة دوال مسح السجلات لحماية audit trail
 */

import { 
  fetchDocuments, 
  saveDocument, 
  getServerTimestamp
} from './firebase-config.js';

import { 
  showToast, 
  formatDateTimeArabic 
} from './utils.js';

class AdminLogsManager {
  constructor() {
    this.lastVisible = null;
    this.hasMore = false;
    this.currentFilter = 'all';
  }

  /**
   * جلب السجلات مع فلترة
   * @param {Object} options 
   * @returns {Promise<Object>}
   */
  async getLogs(options = {}) {
    const loadMore = options.loadMore || false;
    const limitCount = options.limit || 25;

    try {
      const queryFilters = [];
      
      if (this.currentFilter !== 'all') {
        queryFilters.push(['action', '==', this.currentFilter]);
      }

      const queryOptions = {
        filters: queryFilters,
        orderByField: 'timestamp',
        orderDirection: 'desc',
        limitCount: limitCount
      };

      if (loadMore && this.lastVisible) {
        queryOptions.startAfterDoc = this.lastVisible;
      }

      const result = await fetchDocuments('system_logs', queryOptions);

      this.lastVisible = result.lastVisible;
      this.hasMore = result.hasMore && (result.documents || []).length === limitCount;

      return {
        logs: result.documents || [],
        hasMore: this.hasMore
      };

    } catch (error) {
      console.error('❌ فشل جلب السجلات:', error.message);
      throw error;
    }
  }

  /**
   * إضافة سجل جديد للنظام
   * @param {string} action 
   * @param {string} details 
   * @param {string} performedBy 
   * @param {number} affectedCount 
   * @returns {Promise<boolean>}
   */
  async addLog(action, details, performedBy = 'admin', affectedCount = null) {
    try {
      const logData = {
        action: action,
        details: details,
        performed_by: performedBy,
        affected_count: affectedCount,
        timestamp: getServerTimestamp()
      };

      await saveDocument('system_logs', null, logData, false);
      return true;

    } catch (error) {
      console.error('❌ فشل إضافة سجل:', error.message);
      return false;
    }
  }

  /**
   * الحصول على تسمية الإجراء بالعربية
   * @param {string} action 
   * @returns {string}
   */
  getLogActionLabel(action) {
    const labels = {
      mass_promote: 'ترقية جماعية',
      maintenance_on: 'تفعيل الصيانة',
      maintenance_off: 'إيقاف الصيانة',
      student_added: 'إضافة طالب',
      student_deleted: 'حذف طالب',
      bulk_import: 'استيراد طلاب',
      settings_updated: 'تحديث الإعدادات',
      password_reset: 'تغيير كلمة مرور',
      announcement_created: 'نشر إعلان',
      message_sent: 'إرسال رسالة',
      student_login: 'تسجيل دخول طالب',
      admin_login: 'تسجيل دخول مشرف'
    };

    return labels[action] || action;
  }

  /**
   * الحصول على أيقونة الإجراء
   * @param {string} action 
   * @returns {string}
   */
  getLogActionIcon(action) {
    const icons = {
      mass_promote: 'fa-arrow-up',
      maintenance_on: 'fa-power-off',
      maintenance_off: 'fa-power-off',
      student_added: 'fa-user-plus',
      student_deleted: 'fa-user-minus',
      bulk_import: 'fa-file-import',
      settings_updated: 'fa-gear',
      password_reset: 'fa-key',
      announcement_created: 'fa-bullhorn',
      message_sent: 'fa-message',
      student_login: 'fa-right-to-bracket',
      admin_login: 'fa-user-shield'
    };

    return icons[action] || 'fa-circle-info';
  }

  /**
   * تنسيق مدخلة سجل للعرض
   * @param {Object} log 
   * @returns {Object}
   */
  formatLogEntry(log) {
    const timestamp = log.timestamp?.toDate ? log.timestamp.toDate() : new Date(log.timestamp);
    
    return {
      ...log,
      timestampFormatted: formatDateTimeArabic(timestamp),
      actionLabel: this.getLogActionLabel(log.action),
      actionIcon: this.getLogActionIcon(log.action)
    };
  }

  /**
   * إعادة تعيين الفلاتر
   */
  resetFilters() {
    this.currentFilter = 'all';
    this.lastVisible = null;
    this.hasMore = false;
  }

  /**
   * تعيين فلتر الإجراءات
   * @param {string} filter 
   */
  setFilter(filter) {
    this.currentFilter = filter;
    this.lastVisible = null;
    this.hasMore = false;
  }
}

const adminLogs = new AdminLogsManager();

export { AdminLogsManager, adminLogs };

console.log('📦 Admin Logs Manager: جاهز | الإصدار 2.1');
console.log('🔒 وضع القراءة فقط - لا يمكن حذف السجلات');