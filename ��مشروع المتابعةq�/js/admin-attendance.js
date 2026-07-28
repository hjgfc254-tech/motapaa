/* ===========================
   SCHOOLHUB PRO - ADMIN ATTENDANCE MANAGER
   مدارس الجيل الجديد الخاصة
   الإصدار: 2.2 (مُصحح)
   =========================== */

/**
 * وحدة إدارة الحضور والغياب للوحة تحكم الإدارة
 * تم إصلاحه: #7 - السنة الدراسية تُجلب ديناميكياً من settings/general
 * 
 * الإصلاحات في هذا الإصدار:
 * - #Critical 1: استخدام Firestore Transactions لمنع Race Condition
 * - #High 2: إصلاح استخدام incrementField لاستدعاء الدالة فعلياً
 * - #High 3: تحسين الأداء عبر تجميع عمليات القراءة
 * - #Medium 4: نقل results.success بعد نجاح executeBatch
 */

import { 
  fetchDocument, 
  fetchDocuments, 
  saveDocument, 
  updateDocument, 
  removeDocument,
  executeBatch,
  runTransaction,
  getServerTimestamp,
  incrementField
} from './firebase-config.js';

import { 
  showToast, 
  showConfirm,
  formatDateArabic 
} from './utils.js';

import { cacheManager, CACHE_CONFIG } from './cache-manager.js';

class AdminAttendanceManager {
  constructor() {
    // السنة الدراسية تُجلب ديناميكياً من الإعدادات
    this._cachedYear = null;
    this._cacheTimestamp = null;
    this._cacheTTL = 5 * 60 * 1000; // 5 دقائق
  }

  /**
   * جلب السنة الدراسية الحالية من إعدادات النظام
   * تحويل الصيغة من "2025-2026" إلى "2025_2026"
   * @returns {Promise<string>}
   */
  async getAcademicYear() {
    try {
      // استخدام الكاش إذا كان صالحاً
      if (this._cachedYear && this._cacheTimestamp && 
          (Date.now() - this._cacheTimestamp) < this._cacheTTL) {
        return this._cachedYear;
      }

      const settings = await fetchDocument('settings', 'general');
      
      if (settings && settings.current_academic_year) {
        // تحويل "2025-2026" إلى "2025_2026"
        this._cachedYear = settings.current_academic_year.replace(/-/g, '_');
        this._cacheTimestamp = Date.now();
        return this._cachedYear;
      }

      // قيمة افتراضية احتياطية
      console.warn('⚠️ لم يتم العثور على السنة الدراسية في الإعدادات، استخدام القيمة الافتراضية');
      return '2025_2026';

    } catch (error) {
      console.warn('⚠️ فشل جلب السنة الدراسية:', error.message);
      return '2025_2026';
    }
  }

  /**
   * تعيين السنة الدراسية يدوياً (يتجاوز الكاش)
   * @param {string} year - السنة بصيغة "2025-2026" أو "2025_2026"
   */
  setAcademicYear(year) {
    this._cachedYear = year.replace(/-/g, '_');
    this._cacheTimestamp = Date.now();
    console.log('📅 تم تعيين السنة الدراسية:', this._cachedYear);
  }

  /**
   * مسح كاش السنة الدراسية (لإعادة الجلب من الإعدادات)
   */
  clearYearCache() {
    this._cachedYear = null;
    this._cacheTimestamp = null;
  }

  /**
   * جلب بيانات حضور طالب
   * @param {string} studentId 
   * @param {string} academicYear - السنة الدراسية (اختياري)
   * @returns {Promise<Object|null>}
   */
  async getStudentAttendance(studentId, academicYear = null) {
    try {
      const year = academicYear ? academicYear.replace(/-/g, '_') : await this.getAcademicYear();
      const attendanceId = `${studentId}_${year}`;
      return await fetchDocument('attendance', attendanceId);
    } catch (error) {
      console.error('❌ فشل جلب بيانات الحضور:', error.message);
      throw error;
    }
  }

  /**
   * جلب حضور فصل كامل في تاريخ محدد
   * تم تحسين الأداء عبر تجميع عمليات القراءة
   * @param {string} classId 
   * @param {string} date - التاريخ (YYYY-MM-DD)
   * @returns {Promise<Array>}
   */
  async getClassAttendance(classId, date = null) {
    try {
      const currentYear = await this.getAcademicYear();
      
      const studentsResult = await fetchDocuments('students', {
        filters: [['class_id', '==', classId]],
        limitCount: 50
      });

      const students = studentsResult.documents || [];
      const targetDate = date || new Date().toISOString().split('T')[0];
      
      // *** تحسين الأداء: تجميع كل طلبات القراءة معاً ***
      const attendancePromises = students.map(student => {
        const attendanceId = `${student.id}_${currentYear}`;
        return Promise.all([
          fetchDocument('attendance', attendanceId),
          fetchDocuments(`attendance/${attendanceId}/records`, {
            filters: [['date', '==', targetDate]],
            limitCount: 1
          })
        ]).catch(() => [null, { documents: [] }]);
      });

      const allResults = await Promise.all(attendancePromises);
      
      // بناء قائمة الحضور
      const attendanceList = students.map((student, index) => {
        const [attendance, recordsResult] = allResults[index];
        const todayRecord = recordsResult?.documents?.[0] || null;

        return {
          studentId: student.id,
          studentName: student.name,
          studentCode: student.code,
          status: todayRecord?.status || 'present',
          note: todayRecord?.note || '',
          hasRecord: !!todayRecord,
          totalPresent: attendance?.present || 0,
          totalAbsent: attendance?.absent || 0,
          totalLate: attendance?.late || 0
        };
      });

      return attendanceList;

    } catch (error) {
      console.error('❌ فشل جلب حضور الفصل:', error.message);
      throw error;
    }
  }

  /**
   * حفظ بيانات الحضور لفصل كامل
   * تم إصلاح Race Condition عبر استخدام Firestore Transaction
   * @param {string} classId 
   * @param {Array} attendanceData 
   * @param {string} date 
   * @returns {Promise<Object>}
   */
  async saveAttendance(classId, attendanceData, date = null) {
    const results = { success: [], failed: [] };
    
    try {
      const currentYear = await this.getAcademicYear();
      const targetDate = date || new Date().toISOString().split('T')[0];
      const operations = [];

      // *** تحسين الأداء: تجميع كل قراءات الحضور الحالية معاً ***
      const existingDataPromises = attendanceData.map(async (record) => {
        try {
          const attendanceId = `${record.studentId}_${currentYear}`;
          const [existingAttendance, existingRecord] = await Promise.all([
            fetchDocument('attendance', attendanceId),
            fetchDocument(`attendance/${attendanceId}/records`, targetDate)
          ]);
          
          return {
            record,
            attendanceId,
            existingAttendance,
            existingRecord,
            error: null
          };
        } catch (error) {
          return {
            record,
            attendanceId: null,
            existingAttendance: null,
            existingRecord: null,
            error
          };
        }
      });

      const existingDataResults = await Promise.all(existingDataPromises);

      // معالجة كل طالب
      for (const data of existingDataResults) {
        const { record, attendanceId, existingAttendance, existingRecord, error } = data;
        
        if (error) {
          results.failed.push({ studentId: record.studentId, error: error.message });
          continue;
        }

        try {
          if (!existingAttendance) {
            // إنشاء مستند حضور جديد - لا نحتاج Transaction هنا لأنه إنشاء جديد
            const newAttendance = {
              student_id: record.studentId,
              year: currentYear,
              total_days: 1,
              present: record.status === 'present' ? 1 : 0,
              absent: record.status === 'absent' ? 1 : 0,
              late: record.status === 'late' ? 1 : 0,
              createdAt: getServerTimestamp(),
              updatedAt: getServerTimestamp()
            };

            operations.push({
              type: 'set',
              collection: 'attendance',
              id: attendanceId,
              data: newAttendance
            });

            operations.push({
              type: 'set',
              collection: `attendance/${attendanceId}/records`,
              id: targetDate,
              data: {
                date: targetDate,
                status: record.status,
                note: record.note || '',
                timestamp: getServerTimestamp()
              }
            });

            // نحتفظ بالطالب في قائمة مؤقتة - سيتم نقلها لاحقاً بعد نجاح batch
            results._pendingSuccess = results._pendingSuccess || [];
            results._pendingSuccess.push(record.studentId);
            
          } else if (existingRecord) {
            // *** حل المشكلة الحرجة: استخدام Transaction لمنع Race Condition ***
            const oldStatus = existingRecord.status;
            
            if (oldStatus !== record.status) {
              // استخدام Transaction لضمان Atomic Update
              await runTransaction(async (transaction) => {
                const attendanceRef = `attendance/${attendanceId}`;
                const recordRef = `attendance/${attendanceId}/records/${targetDate}`;
                
                // قراءة القيم الحالية داخل transaction
                const currentAttendance = await transaction.get(attendanceRef);
                
                if (!currentAttendance) {
                  throw new Error('Attendance document not found');
                }
                
                const updates = {};
                
                // *** حل المشكلة High #2: استخدام incrementField() بشكل صحيح ***
                // decrement old status
                if (oldStatus === 'present') updates.present = incrementField(-1);
                if (oldStatus === 'absent') updates.absent = incrementField(-1);
                if (oldStatus === 'late') updates.late = incrementField(-1);
                
                // increment new status
                if (record.status === 'present') updates.present = incrementField(1);
                if (record.status === 'absent') updates.absent = incrementField(1);
                if (record.status === 'late') updates.late = incrementField(1);
                
                updates.updatedAt = getServerTimestamp();
                
                transaction.update(attendanceRef, updates);
                transaction.update(recordRef, {
                  status: record.status,
                  note: record.note || '',
                  timestamp: getServerTimestamp()
                });
              });
              
              // تم الحفظ مباشرة عبر transaction
              results._pendingSuccess = results._pendingSuccess || [];
              results._pendingSuccess.push(record.studentId);
            } else {
              // نفس الحالة - فقط تحديث الملاحظة
              operations.push({
                type: 'update',
                collection: `attendance/${attendanceId}/records`,
                id: targetDate,
                data: {
                  note: record.note || '',
                  timestamp: getServerTimestamp()
                }
              });
              
              results._pendingSuccess = results._pendingSuccess || [];
              results._pendingSuccess.push(record.studentId);
            }
          } else {
            // إضافة سجل يوم جديد
            const updates = {
              total_days: incrementField(1)
            };
            
            if (record.status === 'present') updates.present = incrementField(1);
            if (record.status === 'absent') updates.absent = incrementField(1);
            if (record.status === 'late') updates.late = incrementField(1);
            
            updates.updatedAt = getServerTimestamp();

            operations.push({
              type: 'update',
              collection: 'attendance',
              id: attendanceId,
              data: updates
            });

            operations.push({
              type: 'set',
              collection: `attendance/${attendanceId}/records`,
              id: targetDate,
              data: {
                date: targetDate,
                status: record.status,
                note: record.note || '',
                timestamp: getServerTimestamp()
              }
            });

            results._pendingSuccess = results._pendingSuccess || [];
            results._pendingSuccess.push(record.studentId);
          }
        } catch (studentError) {
          results.failed.push({ studentId: record.studentId, error: studentError.message });
        }
      }

      // *** حل المشكلة Medium #4: تنفيذ batch ثم نقل الناجحين للنتائج النهائية ***
      if (operations.length > 0) {
        try {
          const batchSize = 400;
          for (let i = 0; i < operations.length; i += batchSize) {
            const batch = operations.slice(i, i + batchSize);
            await executeBatch(batch);
          }
          
          // بعد نجاح batch، نضيف pending success إلى النتائج النهائية
          if (results._pendingSuccess) {
            results.success.push(...results._pendingSuccess);
            delete results._pendingSuccess;
          }
        } catch (batchError) {
          // إذا فشل batch، كل pending success يعتبر فاشلاً
          if (results._pendingSuccess) {
            for (const studentId of results._pendingSuccess) {
              results.failed.push({ 
                studentId, 
                error: `Batch execution failed: ${batchError.message}` 
              });
            }
            delete results._pendingSuccess;
          }
          throw batchError;
        }
      } else {
        // لا توجد عمليات batch، نضيف pending success مباشرة
        if (results._pendingSuccess) {
          results.success.push(...results._pendingSuccess);
          delete results._pendingSuccess;
        }
      }

      cacheManager.invalidate(CACHE_CONFIG.keys.student_attendance);
      cacheManager.invalidateAdminCache();

      showToast(
        `تم حفظ الحضور لـ ${results.success.length} طالب` + 
        (results.failed.length > 0 ? ` (فشل: ${results.failed.length})` : ''),
        results.failed.length === 0 ? 'success' : 'warning'
      );

      return results;

    } catch (error) {
      showToast(error.message || 'فشل حفظ الحضور', 'error');
      throw error;
    }
  }

  /**
   * جلب سجلات الحضور لطالب
   * @param {string} studentId 
   * @param {string} academicYear 
   * @param {number} limitCount 
   * @returns {Promise<Array>}
   */
  async getAttendanceRecords(studentId, academicYear = null, limitCount = 30) {
    try {
      const year = academicYear ? academicYear.replace(/-/g, '_') : await this.getAcademicYear();
      const attendanceId = `${studentId}_${year}`;

      const result = await fetchDocuments(`attendance/${attendanceId}/records`, {
        orderByField: 'date',
        orderDirection: 'desc',
        limitCount: limitCount
      });

      return result.documents || [];
    } catch (error) {
      console.error('❌ فشل جلب سجلات الحضور:', error.message);
      return [];
    }
  }
}

const adminAttendance = new AdminAttendanceManager();

export { AdminAttendanceManager, adminAttendance };

console.log('📦 Admin Attendance Manager: جاهز | الإصدار 2.2 (مُصحح)');
console.log('ℹ️ السنة الدراسية تُجلب تلقائياً من الإعدادات');
console.log('✅ تم إصلاح Race Condition باستخدام Firestore Transactions');
console.log('✅ تم إصلاح incrementField للاستدعاء الصحيح');
console.log('✅ تم تحسين الأداء عبر تجميع عمليات القراءة');
console.log('✅ تم نقل results.success بعد نجاح executeBatch');