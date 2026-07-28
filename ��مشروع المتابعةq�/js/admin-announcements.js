/* ===========================
   SCHOOLHUB PRO - ADMIN ANNOUNCEMENTS MANAGER
   مدارس الجيل الجديد الخاصة
   الإصدار: 2.0
   =========================== */

/**
 * وحدة إدارة الإعلانات للوحة تحكم الإدارة
 * توفر دوال كاملة لإدارة الإعلانات: إنشاء، تعديل، حذف، نشر موجه
 */

import { 
  fetchDocument, 
  fetchDocuments, 
  saveDocument, 
  updateDocument, 
  removeDocument, 
  incrementField,
  getServerTimestamp
} from './firebase-config.js';

import { 
  showToast, 
  showConfirm, 
  formatDateArabic,
  timeAgoArabic
} from './utils.js';

import { cacheManager, CACHE_CONFIG } from './cache-manager.js';

// ===========================
// ثوابت
// ===========================
const ANNOUNCEMENTS_PER_PAGE = 15;

// ===========================
// كلاس إدارة الإعلانات
// ===========================
class AdminAnnouncementsManager {
  constructor() {
    this.currentFilters = {
      targetType: 'all',
      search: ''
    };
    this.lastVisible = null;
    this.hasMore = false;
    this.isLoading = false;
  }

  /**
   * جلب قائمة الإعلانات
   * @param {Object} options
   * @returns {Promise<Object>}
   */
  async getAnnouncements(options = {}) {
    const loadMore = options.loadMore || false;
    const limitCount = options.limit || ANNOUNCEMENTS_PER_PAGE;

    try {
      this.isLoading = true;

      const queryOptions = {
        orderByField: 'createdAt',
        orderDirection: 'desc',
        limitCount: limitCount
      };

      if (loadMore && this.lastVisible) {
        queryOptions.startAfterDoc = this.lastVisible;
      }

      // فلترة حسب النوع
      if (this.currentFilters.targetType !== 'all') {
        queryOptions.filters = [
          ['target_type', '==', this.currentFilters.targetType]
        ];
      }

      const result = await fetchDocuments('announcements', queryOptions);

      let announcements = result.documents || [];

      // فلترة بالبحث
      if (this.currentFilters.search) {
        const searchTerm = this.currentFilters.search.toLowerCase();
        announcements = announcements.filter(a => {
          return (
            (a.title && a.title.toLowerCase().includes(searchTerm)) ||
            (a.body && a.body.toLowerCase().includes(searchTerm))
          );
        });
      }

      this.lastVisible = result.lastVisible;
      this.hasMore = result.hasMore && announcements.length === limitCount;
      this.isLoading = false;

      return {
        announcements,
        hasMore: this.hasMore,
        total: announcements.length
      };

    } catch (error) {
      this.isLoading = false;
      console.error('❌ فشل جلب الإعلانات:', error.message);
      throw error;
    }
  }

  /**
   * جلب إعلان واحد
   * @param {string} announcementId
   * @returns {Promise<Object|null>}
   */
  async getAnnouncement(announcementId) {
    try {
      return await fetchDocument('announcements', announcementId);
    } catch (error) {
      console.error('❌ فشل جلب الإعلان:', error.message);
      throw error;
    }
  }

  /**
   * إنشاء إعلان جديد
   * @param {Object} data - بيانات الإعلان
   * @returns {Promise<string>} معرف الإعلان الجديد
   */
  async createAnnouncement(data) {
    try {
      // التحقق من البيانات
      this.validateAnnouncementData(data);

      // تجهيز بيانات الإعلان
      const announcement = {
        title: data.title.trim(),
        body: data.body.trim(),
        target_type: data.target_type,
        target_ids: data.target_ids || [],
        target_labels: data.target_labels || [],
        created_by: data.created_by || 'الإدارة',
        createdAt: getServerTimestamp(),
        updatedAt: getServerTimestamp()
      };

      // إذا كان الإعلان للكل، لا نحتاج target_ids
      if (announcement.target_type === 'all') {
        announcement.target_ids = [];
        announcement.target_labels = ['جميع الطلاب'];
      }

      // حفظ الإعلان
      const announcementId = await saveDocument('announcements', null, announcement, false);

      // تحديث العداد
      try {
        await incrementField('counters', 'stats', 'total_announcements', 1);
      } catch (counterError) {
        console.warn('⚠️ فشل تحديث العداد');
      }

      // مسح الكاش
      cacheManager.invalidate(CACHE_CONFIG.keys.student_announcements);
      cacheManager.invalidateAdminCache();

      showToast('تم نشر الإعلان بنجاح 📢', 'success');

      return announcementId;

    } catch (error) {
      showToast(error.message || 'فشل نشر الإعلان', 'error');
      throw error;
    }
  }

  /**
   * تعديل إعلان موجود
   * @param {string} announcementId
   * @param {Object} data
   * @returns {Promise<void>}
   */
  async updateAnnouncement(announcementId, data) {
    try {
      const updateData = {
        ...data,
        updatedAt: getServerTimestamp()
      };

      await updateDocument('announcements', announcementId, updateData);

      cacheManager.invalidate(CACHE_CONFIG.keys.student_announcements);
      cacheManager.invalidateAdminCache();

      showToast('تم تحديث الإعلان بنجاح ✅', 'success');

    } catch (error) {
      showToast(error.message || 'فشل تحديث الإعلان', 'error');
      throw error;
    }
  }

  /**
   * حذف إعلان
   * @param {string} announcementId
   * @returns {Promise<void>}
   */
  async deleteAnnouncement(announcementId) {
    try {
      const confirmed = await showConfirm(
        'هل أنت متأكد من حذف هذا الإعلان؟',
        'تأكيد الحذف',
        'نعم، احذف',
        'إلغاء'
      );

      if (!confirmed) return;

      await removeDocument('announcements', announcementId);

      // تحديث العداد
      try {
        await incrementField('counters', 'stats', 'total_announcements', -1);
      } catch (counterError) {
        console.warn('⚠️ فشل تحديث العداد');
      }

      cacheManager.invalidate(CACHE_CONFIG.keys.student_announcements);
      cacheManager.invalidateAdminCache();

      showToast('تم حذف الإعلان بنجاح 🗑️', 'success');

    } catch (error) {
      showToast(error.message || 'فشل حذف الإعلان', 'error');
      throw error;
    }
  }

  /**
   * نشر إعلان موجه لفئة محددة
   * @param {Object} data
   * @returns {Promise<string>}
   */
  async createTargetedAnnouncement(data) {
    // التحقق من وجود target_ids عند الحاجة
    if (data.target_type !== 'all' && (!data.target_ids || data.target_ids.length === 0)) {
      throw new Error('يرجى تحديد المستهدفين من الإعلان');
    }

    return await this.createAnnouncement(data);
  }

  /**
   * نشر إعلان عاجل لطالب محدد
   * @param {string} studentId
   * @param {string} studentName
   * @param {string} title
   * @param {string} body
   * @returns {Promise<string>}
   */
  async sendUrgentAnnouncement(studentId, studentName, title, body) {
    return await this.createAnnouncement({
      title: `⚠️ هام: ${title}`,
      body: body,
      target_type: 'student',
      target_ids: [studentId],
      target_labels: [studentName],
      created_by: 'الإدارة'
    });
  }

  /**
   * نشر إعلان لمرحلة كاملة
   * @param {string} stageId
   * @param {string} stageName
   * @param {string} title
   * @param {string} body
   * @returns {Promise<string>}
   */
  async sendStageAnnouncement(stageId, stageName, title, body) {
    return await this.createAnnouncement({
      title: title,
      body: body,
      target_type: 'stage',
      target_ids: [stageId],
      target_labels: [stageName],
      created_by: 'الإدارة'
    });
  }

  /**
   * نشر إعلان لفصل محدد
   * @param {string} classId
   * @param {string} className
   * @param {string} title
   * @param {string} body
   * @returns {Promise<string>}
   */
  async sendClassAnnouncement(classId, className, title, body) {
    return await this.createAnnouncement({
      title: title,
      body: body,
      target_type: 'class',
      target_ids: [classId],
      target_labels: [className],
      created_by: 'الإدارة'
    });
  }

  /**
   * نشر إعلان عام لكل المدرسة
   * @param {string} title
   * @param {string} body
   * @returns {Promise<string>}
   */
  async sendGeneralAnnouncement(title, body) {
    return await this.createAnnouncement({
      title: title,
      body: body,
      target_type: 'all',
      target_ids: [],
      target_labels: ['جميع الطلاب'],
      created_by: 'الإدارة'
    });
  }

  /**
   * التحقق من صحة بيانات الإعلان
   * @param {Object} data
   */
  validateAnnouncementData(data) {
    if (!data.title || !data.title.trim()) {
      throw new Error('عنوان الإعلان مطلوب');
    }

    if (!data.body || !data.body.trim()) {
      throw new Error('محتوى الإعلان مطلوب');
    }

    if (!data.target_type) {
      throw new Error('نوع الإعلان (عام/مرحلة/فصل/طالب) مطلوب');
    }

    const validTypes = ['all', 'stage', 'class', 'student'];
    if (!validTypes.includes(data.target_type)) {
      throw new Error('نوع الإعلان غير صحيح');
    }

    if (data.title.length > 150) {
      throw new Error('عنوان الإعلان يجب ألا يتجاوز 150 حرفاً');
    }

    if (data.body.length > 2000) {
      throw new Error('محتوى الإعلان يجب ألا يتجاوز 2000 حرف');
    }
  }

  /**
   * الحصول على إحصائيات الإعلانات
   * @returns {Promise<Object>}
   */
  async getAnnouncementStats() {
    try {
      const [allResult, stageResult, classResult, studentResult] = await Promise.all([
        fetchDocuments('announcements', { filters: [['target_type', '==', 'all']], limitCount: 1 }),
        fetchDocuments('announcements', { filters: [['target_type', '==', 'stage']], limitCount: 1 }),
        fetchDocuments('announcements', { filters: [['target_type', '==', 'class']], limitCount: 1 }),
        fetchDocuments('announcements', { filters: [['target_type', '==', 'student']], limitCount: 1 })
      ]);

      return {
        total: (allResult.documents?.length || 0) + 
               (stageResult.documents?.length || 0) + 
               (classResult.documents?.length || 0) + 
               (studentResult.documents?.length || 0),
        general: allResult.documents?.length || 0,
        stage: stageResult.documents?.length || 0,
        class: classResult.documents?.length || 0,
        student: studentResult.documents?.length || 0
      };
    } catch (error) {
      console.error('❌ فشل جلب إحصائيات الإعلانات:', error.message);
      return { total: 0, general: 0, stage: 0, class: 0, student: 0 };
    }
  }

  /**
   * حذف الإعلانات منتهية الصلاحية
   * @returns {Promise<number>} عدد الإعلانات المحذوفة
   */
  async cleanExpiredAnnouncements() {
    try {
      const now = new Date();
      const result = await fetchDocuments('announcements', {
        filters: [['expiresAt', '<=', now.toISOString()]],
        limitCount: 100
      });

      const expiredAnnouncements = result.documents || [];
      
      if (expiredAnnouncements.length === 0) {
        return 0;
      }

      for (const announcement of expiredAnnouncements) {
        await removeDocument('announcements', announcement.id);
      }

      cacheManager.invalidate(CACHE_CONFIG.keys.student_announcements);
      
      console.log(`🗑️ تم حذف ${expiredAnnouncements.length} إعلان منتهي الصلاحية`);
      return expiredAnnouncements.length;

    } catch (error) {
      console.error('❌ فشل تنظيف الإعلانات:', error.message);
      return 0;
    }
  }

  /**
   * إعادة تعيين الفلاتر
   */
  resetFilters() {
    this.currentFilters = {
      targetType: 'all',
      search: ''
    };
    this.lastVisible = null;
    this.hasMore = false;
  }
}

// ===========================
// نسخة واحدة (Singleton)
// ===========================
const adminAnnouncements = new AdminAnnouncementsManager();

// ===========================
// دوال مساعدة
// ===========================

/**
 * تنسيق الإعلان للعرض
 * @param {Object} announcement
 * @returns {Object}
 */
function formatAnnouncementForDisplay(announcement) {
  const createdAt = announcement.createdAt?.toDate ? 
    announcement.createdAt.toDate() : 
    new Date(announcement.createdAt);

  const targetTypeLabels = {
    all: 'عام - كل المدرسة',
    stage: 'مرحلة دراسية',
    class: 'فصل دراسي',
    student: 'طالب محدد'
  };

  return {
    ...announcement,
    createdAtFormatted: formatDateArabic(createdAt),
    timeAgo: timeAgoArabic(createdAt),
    targetTypeLabel: targetTypeLabels[announcement.target_type] || announcement.target_type,
    isExpired: announcement.expiresAt ? new Date(announcement.expiresAt) < new Date() : false
  };
}

// ===========================
// تصدير
// ===========================
export {
  AdminAnnouncementsManager,
  adminAnnouncements,
  formatAnnouncementForDisplay,
  ANNOUNCEMENTS_PER_PAGE
};

// ===========================
// رسالة جاهزية
// ===========================
console.log('📦 Admin Announcements Manager: جاهز');
console.log('ℹ️ استخدم adminAnnouncements.createAnnouncement() لإنشاء إعلان');
console.log('ℹ️ استخدم adminAnnouncements.sendGeneralAnnouncement() لإعلان عام');
console.log('ℹ️ استخدم adminAnnouncements.sendUrgentAnnouncement() لإعلان عاجل');