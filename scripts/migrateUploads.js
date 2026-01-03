const fs = require('fs');
const path = require('path');

/**
 * Migration script to move existing files from uploads root to appropriate subfolders
 * - PDF files -> uploads/lesson-plan/
 * - Video files (mp4, webm, ogg, mov, avi) -> uploads/videos/
 */

const uploadsDir = path.join(__dirname, '../uploads');
const lessonPlanDir = path.join(uploadsDir, 'lesson-plan');
const videosDir = path.join(uploadsDir, 'videos');

// Video file extensions
const videoExtensions = ['.mp4', '.webm', '.ogg', '.mov', '.avi'];

function migrateFiles() {
  console.log('Starting file migration...');
  
  // Ensure subdirectories exist
  if (!fs.existsSync(lessonPlanDir)) {
    fs.mkdirSync(lessonPlanDir, { recursive: true });
    console.log('Created lesson-plan directory');
  }
  
  if (!fs.existsSync(videosDir)) {
    fs.mkdirSync(videosDir, { recursive: true });
    console.log('Created videos directory');
  }
  
  // Check if uploads directory exists
  if (!fs.existsSync(uploadsDir)) {
    console.log('Uploads directory does not exist. Nothing to migrate.');
    return;
  }
  
  // Read all files in uploads directory
  const files = fs.readdirSync(uploadsDir);
  
  // Filter out directories (we only want files)
  const fileStats = files
    .map(file => {
      const filePath = path.join(uploadsDir, file);
      const stat = fs.statSync(filePath);
      return { name: file, path: filePath, isFile: stat.isFile() };
    })
    .filter(item => item.isFile);
  
  let movedPdfs = 0;
  let movedVideos = 0;
  let skipped = 0;
  
  fileStats.forEach(({ name, path: filePath }) => {
    const ext = path.extname(name).toLowerCase();
    
    if (ext === '.pdf') {
      // Move to lesson-plan folder
      const destPath = path.join(lessonPlanDir, name);
      if (!fs.existsSync(destPath)) {
        fs.renameSync(filePath, destPath);
        movedPdfs++;
        console.log(`Moved PDF: ${name} -> lesson-plan/`);
      } else {
        console.log(`Skipped ${name} (already exists in lesson-plan/)`);
        skipped++;
      }
    } else if (videoExtensions.includes(ext)) {
      // Move to videos folder
      const destPath = path.join(videosDir, name);
      if (!fs.existsSync(destPath)) {
        fs.renameSync(filePath, destPath);
        movedVideos++;
        console.log(`Moved video: ${name} -> videos/`);
      } else {
        console.log(`Skipped ${name} (already exists in videos/)`);
        skipped++;
      }
    } else {
      // Unknown file type - leave in root
      console.log(`Skipped ${name} (unknown file type: ${ext})`);
      skipped++;
    }
  });
  
  console.log('\nMigration complete!');
  console.log(`- Moved ${movedPdfs} PDF file(s) to lesson-plan/`);
  console.log(`- Moved ${movedVideos} video file(s) to videos/`);
  console.log(`- Skipped ${skipped} file(s)`);
}

// Run migration
if (require.main === module) {
  try {
    migrateFiles();
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

module.exports = { migrateFiles };

