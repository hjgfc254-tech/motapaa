/* ===========================
   SCHOOLHUB PRO - ADMIN STAGES MANAGER
   مدارس الجيل الجديد الخاصة
   الإصدار: 2.0
   =========================== */

/**
 * وحدة إدارة المراحل الدراسية والفصول للوحة تحكم الإدارة
 * توفر دوال كاملة لإدارة هيكل المدرسة
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
  showConfirm 
} from './utils.js';

import { cacheManager, CACHE_CONFIG } from './cache-manager.js';

class AdminStagesManager {
  constructor() {
    this.currentStage = null;
    this.currentClass = null;
  }

  /**
   * جلب جميع المراحل الدراسية
   * @returns {Promise<Array>}
   */
  async getStages() {
    try {
      const result = await fetchDocuments('school_structure', {
        orderByField: 'order',
        orderDirection: 'asc',
        limitCount: 20
      });

      return result.documents || [];
    } catch (error) {
      console.error('❌ فشل جلب المراحل:', error.message);
      throw error;
    }
  }

  /**
   * جلب مرحلة واحدة
   * @param {string} stageId 
   * @returns {Promise<Object|null>}
   */
  async getStage(stageId) {
    try {
      return await fetchDocument('school_structure', stageId);
    } catch (error) {
      console.error('❌ فشل جلب المرحلة:', error.message);
      throw error;
    }
  }

  /**
   * إضافة مرحلة دراسية جديدة
   * @param {Object} data 
   * @returns {Promise<string>}
   */
  async addStage(data) {
    try {
      if (!data.name || !data.name.trim()) {
        throw new Error('اسم المرحلة مطلوب');
      }

      // جلب أعلى ترتيب حالي
      const stages = await this.getStages();
      const maxOrder = stages.reduce((max, s) => Math.max(max, s.order || 0), 0);

      const stage = {
        name: data.name.trim(),
        level: data.level || maxOrder + 1,
        order: data.order || maxOrder + 1,
        createdAt: getServerTimestamp(),
        updatedAt: getServerTimestamp()
      };

      const stageId = await saveDocument('school_structure', null, stage, false);

      try {
        await incrementField('counters', 'stats', 'total_stages', 1);
      } catch (e) {}

      cacheManager.invalidate(CACHE_CONFIG.keys.school_structure);
      cacheManager.invalidateAdminCache();

      showToast('تم إضافة المرحلة بنجاح ✅', 'success');
      return stageId;

    } catch (error) {
      showToast(error.message || 'فشل إضافة المرحلة', 'error');
      throw error;
    }
  }

  /**
   * تعديل مرحلة
   * @param {string} stageId 
   * @param {Object} data 
   * @returns {Promise<void>}
   */
  async updateStage(stageId, data) {
    try {
      await updateDocument('school_structure', stageId, {
        ...data,
        updatedAt: getServerTimestamp()
      });

      cacheManager.invalidate(CACHE_CONFIG.keys.school_structure);
      cacheManager.invalidateAdminCache();
      showToast('تم تحديث المرحلة ✅', 'success');

    } catch (error) {
      showToast('فشل تحديث المرحلة', 'error');
      throw error;
    }
  }

  /**
   * حذف مرحلة (مع التحقق من عدم وجود طلاب)
   * @param {string} stageId 
   * @returns {Promise<void>}
   */
  async deleteStage(stageId) {
    try {
      const stage = await this.getStage(stageId);
      if (!stage) throw new Error('المرحلة غير موجودة');

      // التحقق من وجود طلاب في هذه المرحلة
      const studentsResult = await fetchDocuments('students', {
        filters: [['stage_id', '==', stageId]],
        limitCount: 1
      });

      if (studentsResult.documents && studentsResult.documents.length > 0) {
        throw new Error('لا يمكن حذف المرحلة لأن بها طلاباً. انقل الطلاب أولاً أو احذفهم.');
      }

      const confirmed = await showConfirm(
        `هل أنت متأكد من حذف مرحلة "${stage.name}"؟ لا يمكن التراجع.`,
        'تأكيد الحذف',
        'نعم، احذف',
        'إلغاء'
      );

      if (!confirmed) return;

      await removeDocument('school_structure', stageId);

      try {
        await incrementField('counters', 'stats', 'total_stages', -1);
      } catch (e) {}

      cacheManager.invalidate(CACHE_CONFIG.keys.school_structure);
      cacheManager.invalidateAdminCache();

      showToast('تم حذف المرحلة بنجاح 🗑️', 'success');

    } catch (error) {
      showToast(error.message || 'فشل حذف المرحلة', 'error');
      throw error;
    }
  }

  /**
   * جلب فصول مرحلة محددة
   * @param {string} stageId 
   * @returns {Promise<Array>}
   */
  async getClasses(stageId) {
    try {
      const result = await fetchDocuments('school_structure', {
        filters: [['stage_id', '==', stageId]],
        orderByField: 'order',
        orderDirection: 'asc',
        limitCount: 30
      });

      return result.documents || [];
    } catch (error) {
      console.error('❌ فشل جلب الفصول:', error.message);
      throw error;
    }
  }

  /**
   * إضافة فصل جديد لمرحلة
   * @param {string} stageId 
   * @param {Object} data 
   * @returns {Promise<string>}
   */
  async addClass(stageId, data) {
    try {
      if (!data.name || !data.name.trim()) {
        throw new Error('اسم الفصل مطلوب');
      }

      const stage = await this.getStage(stageId);
      if (!stage) throw new Error('المرحلة غير موجودة');

      const classData = {
        name: data.name.trim(),
        stage_id: stageId,
        stage_name: stage.name,
        order: data.order || 1,
        createdAt: getServerTimestamp(),
        updatedAt: getServerTimestamp()
      };

      const classId = await saveDocument('school_structure', null, classData, false);

      try {
        await incrementField('counters', 'stats', 'total_classes', 1);
      } catch (e) {}

      cacheManager.invalidate(CACHE_CONFIG.keys.school_structure);
      cacheManager.invalidateAdminCache();

      showToast(`تم إضافة فصل "${data.name}" بنجاح ✅`, 'success');
      return classId;

    } catch (error) {
      showToast(error.message || 'فشل إضافة الفصل', 'error');
      throw error;
    }
  }

  /**
   * تعديل فصل
   * @param {string} classId 
   * @param {Object} data 
   * @returns {Promise<void>}
   */
  async updateClass(classId, data) {
    try {
      await updateDocument('school_structure', classId, {
        ...data,
        updatedAt: getServerTimestamp()
      });

      cacheManager.invalidate(CACHE_CONFIG.keys.school_structure);
      cacheManager.invalidateAdminCache();
      showToast('تم تحديث الفصل ✅', 'success');

    } catch (error) {
      showToast('فشل تحديث الفصل', 'error');
      throw error;
    }
  }

  /**
   * حذف فصل
   * @param {string} classId 
   * @returns {Promise<void>}
   */
  async deleteClass(classId) {
    try {
      const classDoc = await fetchDocument('school_structure', classId);
      if (!classDoc) throw new Error('الفصل غير موجود');

      const studentsResult = await fetchDocuments('students', {
        filters: [['class_id', '==', classId]],
        limitCount: 1
      });

      if (studentsResult.documents && studentsResult.documents.length > 0) {
        throw new Error('لا يمكن حذف الفصل لأن به طلاباً.');
      }

      const confirmed = await showConfirm(
        `هل أنت متأكد من حذف فصل "${classDoc.name}"؟`,
        'تأكيد الحذف',
        'نعم، احذف',
        'إلغاء'
      );

      if (!confirmed) return;

      await removeDocument('school_structure', classId);

      try {
        await incrementField('counters', 'stats', 'total_classes', -1);
      } catch (e) {}

      cacheManager.invalidate(CACHE_CONFIG.keys.school_structure);
      cacheManager.invalidateAdminCache();

      showToast('تم حذف الفصل بنجاح 🗑️', 'success');

    } catch (error) {
      showToast(error.message || 'فشل حذف الفصل', 'error');
      throw error;
    }
  }
}

const adminStages = new AdminStagesManager();

export { AdminStagesManager, adminStages };

console.log('📦 Admin Stages Manager: جاهز');