const mongoose = require('mongoose');
require('dotenv').config();

const { LandingPage, LandingPageSettings } = require('../models/LandingPage');

/**
 * Migration script to add default values for new fields in existing landing page data
 */
async function migrateLandingPage() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGO_URI);
    console.log('Connected to MongoDB');

    // Get all existing sections
    const sections = await LandingPage.find();
    console.log(`Found ${sections.length} sections to migrate`);

    // Update sections with default styling and animation if missing
    for (const section of sections) {
      const updates = {};
      
      if (!section.styling) {
        updates.styling = {};
      }
      
      if (!section.animation) {
        updates.animation = {
          type: 'none',
          duration: 0.8,
          delay: 0,
          easing: 'easeOut'
        };
      }

      if (Object.keys(updates).length > 0) {
        await LandingPage.updateOne(
          { _id: section._id },
          { $set: updates }
        );
        console.log(`Updated section: ${section.id}`);
      }
    }

    // Ensure default settings exist
    const defaultSettings = {
      header: {
        leftLogo: "/Images/coatofarms.svg",
        rightLogo: "/Images/tielogo.png",
        title: "Teacher's Skills Competition System",
        navigation: [],
        styling: {
          backgroundColor: "rgba(255, 255, 255, 0.95)",
          textColor: "#1a1a1a",
          height: 80,
          showNavigation: false
        }
      },
      footer: {
        columns: [],
        logos: [],
        socialMedia: [],
        copyright: "© 2024 Teacher's Skills Competition System. All rights reserved.",
        styling: {
          backgroundColor: "#1a1a1a",
          textColor: "rgba(255, 255, 255, 0.7)",
          padding: "40px 20px"
        }
      },
      theme: {
        colors: {
          primary: "#1890ff",
          secondary: "#096dd9",
          background: "#ffffff",
          text: "#1a1a1a",
          textSecondary: "#666666",
          accent: "#f59e0b"
        },
        fonts: {
          heading: "system-ui, -apple-system, sans-serif",
          body: "system-ui, -apple-system, sans-serif",
          sizes: {
            h1: "4.5rem",
            h2: "3rem",
            h3: "2rem",
            body: "1.1rem",
            small: "0.9rem"
          }
        },
        spacing: {
          sectionPadding: "120px 20px",
          containerMaxWidth: "1400px",
          cardPadding: "32px"
        },
        effects: {
          shadows: true,
          borderRadius: "16px",
          transitions: true
        }
      },
      navigation: [],
      seo: {
        metaTitle: "Teacher's Skills Competition System",
        metaDescription: "Celebrating Excellence in Education - Join the Teacher's Skills Competition System",
        ogImage: "",
        twitterCard: "summary_large_image",
        keywords: "education, teachers, competition, skills, excellence"
      }
    };

    // Create or update header setting
    await LandingPageSettings.findOneAndUpdate(
      { key: 'header' },
      { key: 'header', value: defaultSettings.header },
      { upsert: true, new: true }
    );
    console.log('Header setting migrated');

    // Create or update footer setting
    await LandingPageSettings.findOneAndUpdate(
      { key: 'footer' },
      { key: 'footer', value: defaultSettings.footer },
      { upsert: true, new: true }
    );
    console.log('Footer setting migrated');

    // Create or update theme setting
    await LandingPageSettings.findOneAndUpdate(
      { key: 'theme' },
      { key: 'theme', value: defaultSettings.theme },
      { upsert: true, new: true }
    );
    console.log('Theme setting migrated');

    // Create or update navigation setting
    await LandingPageSettings.findOneAndUpdate(
      { key: 'navigation' },
      { key: 'navigation', value: defaultSettings.navigation },
      { upsert: true, new: true }
    );
    console.log('Navigation setting migrated');

    // Create or update SEO setting
    await LandingPageSettings.findOneAndUpdate(
      { key: 'seo' },
      { key: 'seo', value: defaultSettings.seo },
      { upsert: true, new: true }
    );
    console.log('SEO setting migrated');

    console.log('Migration completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('Migration error:', error);
    process.exit(1);
  }
}

// Run migration
migrateLandingPage();









