/* ===========================
   SCHOOLHUB PRO - ADMIN SCHEDULES MANAGER
   مدارس الجيل الجديد الخاصة
   الإصدار: 2.0
   =========================== */

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

const DAYS = ['saturday', 'sunday', 'monday', 'tuesday', 'wednesday', 'thursday'];
const DAY_NAMES_AR = {
  saturday: 'السبت',
  sunday: 'الأحد',
  monday: 'الإثنين',
  tuesday: 'الثلاثاء',
  wednesday: 'الأربعاء',
  thursday: 'الخميس'
};

class AdminSchedulesManager {
  constructor() {}

  async getSchedule(classId) {
    try {
      const scheduleId = `${classId}_schedule`;
      return await fetchDocument('schedules', scheduleId);
    } catch (error) {
      console.error('❌ فشل جلب الجدول:', error.message);
      throw error;
    }
  }

  async getSchedulesForStage(stageId) {
    try {
      const classes = await fetchDocuments('school_structure', {
        filters: [['stage_id', '==', stageId]],
        limitCount: 30
      });

      const classList = classes.documents || [];
      const schedules = [];

      for (const cls of classList) {
        const scheduleId = `${cls.id}_schedule`;
        try {
          const schedule = await fetchDocument('schedules', scheduleId);
          if (schedule) {
            schedules.push({ classId: cls.id, className: cls.name, schedule });
          }
        } catch (e) {}
      }

      return schedules;
    } catch (error) {
      console.error('❌ فشل جلب جداول المرحلة:', error.message);
      throw error;
    }
  }

  async saveSchedule(classId, className, daysData) {
    try {
      if (!classId) throw new Error('معرف الفصل مطلوب');

      const scheduleId = `${classId}_schedule`;
      const existing = await fetchDocument('schedules', scheduleId);

      const days = {};
      DAYS.forEach(day => {
        days[day] = daysData[day] || [];
      });

      const scheduleData = {
        class_id: classId,
        class_name: className || existing?.class_name || '',
        days: days,
        updatedAt: getServerTimestamp()
      };

      if (!existing) {
        scheduleData.createdAt = getServerTimestamp();
        await saveDocument('schedules', scheduleId, scheduleData, false);
        try { await incrementField('counters', 'stats', 'total_schedules', 1); } catch (e) {}
      } else {
        await updateDocument('schedules', scheduleId, scheduleData);
      }

      cacheManager.invalidate(CACHE_CONFIG.keys.student_schedule);
      cacheManager.invalidateAdminCache();

      showToast('تم حفظ جدول الحصص بنجاح ✅', 'success');
      return scheduleId;

    } catch (error) {
      showToast(error.message || 'فشل حفظ الجدول', 'error');
      throw error;
    }
  }

  async deleteSchedule(classId) {
    try {
      const scheduleId = `${classId}_schedule`;
      const existing = await fetchDocument('schedules', scheduleId);
      
      if (!existing) {
        showToast('لا يوجد جدول لهذا الفصل', 'info');
        return;
      }

      const confirmed = await showConfirm(
        `هل أنت متأكد من حذف جدول "${existing.class_name}"؟`,
        'تأكيد الحذف',
        'نعم، احذف',
        'إلغاء'
      );

      if (!confirmed) return;

      await removeDocument('schedules', scheduleId);

      try { await incrementField('counters', 'stats', 'total_schedules', -1); } catch (e) {}

      cacheManager.invalidate(CACHE_CONFIG.keys.student_schedule);
      cacheManager.invalidateAdminCache();

      showToast('تم حذف الجدول بنجاح 🗑️', 'success');

    } catch (error) {
      showToast(error.message || 'فشل حذف الجدول', 'error');
      throw error;
    }
  }

  getEmptyScheduleTemplate() {
    const template = {};
    DAYS.forEach(day => {
      template[day] = [];
    });
    return template;
  }

  getDayName(dayKey) {
    return DAY_NAMES_AR[dayKey] || dayKey;
  }

  getDays() {
    return DAYS;
  }
}

const adminSchedules = new AdminSchedulesManager();

export { AdminSchedulesManager, adminSchedules, DAYS, DAY_NAMES_AR };

console.log('📦 Admin Schedules Manager: جاهز');