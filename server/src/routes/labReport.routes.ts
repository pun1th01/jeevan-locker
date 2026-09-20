import { Router } from 'express';
import { uploadLabReport } from '../controllers/labReport.controller';
import { requireRole, verifyToken } from '../middleware/auth.middleware';
import { uploadMedicalDocument } from '../middleware/upload.middleware';

const router = Router();

router.use(verifyToken, requireRole('lab'));

// Same multer instance as the patient upload: 5 MB, one file, PDF/JPEG/PNG whitelist.
router.post('/', uploadMedicalDocument.single('file'), uploadLabReport);

export default router;
