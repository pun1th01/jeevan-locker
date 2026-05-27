import { Router } from 'express';
import {
  getDocument,
  getMyDocuments,
  listDoctors,
  shareDocumentWithDoctor,
  uploadDocument,
} from '../controllers/document.controller';
import { requireRole, verifyToken } from '../middleware/auth.middleware';
import { uploadMedicalDocument } from '../middleware/upload.middleware';

const router = Router();

router.use(verifyToken);

router.get('/doctors', requireRole('patient', 'admin'), listDoctors);
router.post('/upload', requireRole('patient'), uploadMedicalDocument.single('file'), uploadDocument);
router.get('/my-documents', getMyDocuments);
router.get('/:id', getDocument);
router.patch('/:id/share', requireRole('patient'), shareDocumentWithDoctor);

export default router;
