/* ===========================
   SCHOOLHUB PRO - ADMIN ATTENDANCE MANAGER
   مدارس الجيل الجديد الخاصة
   الإصدار: 2.3 (مُصحح - runTransaction من Firebase SDK)
   =========================== */

import { 
  fetchDocument, 
  fetchDocuments, 
  saveDocument, 
  updateDocument, 
  removeDocument,
  executeBatch,
  getServerTimestamp,
  incrementField
} from './firebase-config.js';

import { runTransaction } from "https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js";

import { 
  showToast, 
  showConfirm,
  formatDateArabic 
} from './utils.js';

import { cacheManager, CACHE_CONFIG } from './cache-manager.js';

class AdminAttendanceManager {
  constructor() {
    this._cachedYear = null;
    this._cacheTimestamp = null;
    this._cacheTTL = 5 * 60 * 1000;
  }

  async getAcademicYear() {
    try {
      if (this._cachedYear && this._cacheTimestamp && 
          (Date.now() - this._cacheTimestamp) < this._cacheTTL) {
        return this._cachedYear;
      }

      const settings = await fetchDocument('settings', 'general');
      
      if (settings && settings.current_academic_year) {
        this._cachedYear = settings.current_academic_year.replace(/-/g, '_');
        this._cacheTimestamp = Date.now();
        return this._cachedYear;
      }

      console.warn('⚠️ لم يتم العثور على السنة الدراسية في الإعدادات، استخدام القيمة الافتراضية');
      return '2025_2026';

    } catch (error) {
      console.warn('⚠️ فشل جلب السنة الدراسية:', error.message);
      return '2025_2026';
    }
  }

  setAcademicYear(year) {
    this._cachedYear = year.replace(/-/g, '_');
    this._cacheTimestamp = Date.now();
    console.log('📅 تم تعيين السنة الدراسية:', this._cachedYear);
  }

  clearYearCache() {
    this._cachedYear = null;
    this._cacheTimestamp = null;
  }

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

  async getClassAttendance(classId, date = null) {
    try {
      const currentYear = await this.getAcademicYear();
      
      const studentsResult = await fetchDocuments('students', {
        filters: [['class_id', '==', classId]],
        limitCount: 50
      });

      const students = studentsResult.documents || [];
      const targetDate = date || new Date().toISOString().split('T')[0];
      
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

  async saveAttendance(classId, attendanceData, date = null) {
    const results = { success: [], failed: [] };
    
    try {
      const currentYear = await this.getAcademicYear();
      const targetDate = date || new Date().toISOString().split('T')[0];
      const operations = [];

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

      for (const data of existingDataResults) {
        const { record, attendanceId, existingAttendance, existingRecord, error } = data;
        
        if (error) {
          results.failed.push({ studentId: record.studentId, error: error.message });
          continue;
        }

        try {
          if (!existingAttendance) {
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

            results._pendingSuccess = results._pendingSuccess || [];
            results._pendingSuccess.push(record.studentId);
            
          } else if (existingRecord) {
            const oldStatus = existingRecord.status;
            
            if (oldStatus !== record.status) {
              await runTransaction(async (transaction) => {
                const attendanceRef = `attendance/${attendanceId}`;
                const recordRef = `attendance/${attendanceId}/records/${targetDate}`;
                
                const currentAttendance = await transaction.get(attendanceRef);
                
                if (!currentAttendance) {
                  throw new Error('Attendance document not found');
                }
                
                const updates = {};
                
                if (oldStatus === 'present') updates.present = incrementField(-1);
                if (oldStatus === 'absent') updates.absent = incrementField(-1);
                if (oldStatus === 'late') updates.late = incrementField(-1);
                
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
              
              results._pendingSuccess = results._pendingSuccess || [];
              results._pendingSuccess.push(record.studentId);
            } else {
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

      if (operations.length > 0) {
        try {
          const batchSize = 400;
          for (let i = 0; i < operations.length; i += batchSize) {
            const batch = operations.slice(i, i + batchSize);
            await executeBatch(batch);
          }
          
          if (results._pendingSuccess) {
            results.success.push(...results._pendingSuccess);
            delete results._pendingSuccess;
          }
        } catch (batchError) {
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

console.log('📦 Admin Attendance Manager: جاهز | الإصدار 2.3 (مُصحح - runTransaction من SDK)');
console.log('ℹ️ السنة الدراسية تُجلب تلقائياً من الإعدادات');
console.log('✅ تم إصلاح استيراد runTransaction من Firebase SDK مباشرة');
