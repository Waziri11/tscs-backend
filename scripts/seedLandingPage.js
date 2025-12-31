const mongoose = require('mongoose');
require('dotenv').config();

const { LandingPage, LandingPageSettings } = require('../models/LandingPage');

// Default landing page content matching frontend structure
const defaultLandingContent = {
  settings: {
    siteName: "Teacher's Skills Competition System",
    footerText: "© 2024 Teacher's Skills Competition System. All rights reserved.",
  },
  sections: [
    {
      id: 'hero',
      type: 'hero',
      enabled: true,
      order: 0,
      content: {
        title: "Teacher's Skills Competition System",
        subtitle: "Celebrating Excellence in Education",
        backgroundImage: "/Images/landing_page_images/tscs1.jpg",
        primaryButtonText: "Join the Competition",
        primaryButtonLink: "/register",
        secondaryButtonText: "Login",
        secondaryButtonLink: "/login",
        scrollText: "Scroll to explore",
      },
    },
    {
      id: 'stats',
      type: 'stats',
      enabled: true,
      order: 1,
      content: {
        items: [
          { id: 'stat1', title: 'Active Teachers', value: 500, icon: 'team', color: '#667eea' },
          { id: 'stat2', title: 'Competitions', value: 12, icon: 'trophy', color: '#f59e0b' },
          { id: 'stat3', title: 'Submissions', value: 1200, icon: 'check', color: '#10b981' },
          { id: 'stat4', title: 'Success Rate', value: 95, icon: 'percent', color: '#ef4444', suffix: '%' },
        ],
      },
    },
    {
      id: 'about',
      type: 'about',
      enabled: true,
      order: 2,
      content: {
        title: 'About the Competition',
        paragraphs: [
          "The Teacher's Skills Competition System is a prestigious platform designed to recognize, celebrate, and elevate teaching excellence across educational institutions. We provide educators with opportunities to showcase their innovative teaching methods, creative lesson planning, and exceptional classroom management skills.",
          "Our mission is to foster a culture of continuous improvement in education by highlighting best practices and encouraging teachers to share their expertise with the broader educational community.",
        ],
        image: "/Images/landing_page_images/tscs2.jpg",
        imagePosition: 'left',
        tags: [
          { text: '500+ Teachers', icon: 'team', color: 'blue' },
          { text: '12 Competitions', icon: 'trophy', color: 'gold' },
          { text: 'Excellence Awards', icon: 'star', color: 'orange' },
        ],
      },
    },
    {
      id: 'criteria',
      type: 'criteria',
      enabled: true,
      order: 3,
      content: {
        title: 'Competition Criteria',
        subtitle: 'All submissions are evaluated based on comprehensive criteria designed to assess teaching excellence across multiple dimensions',
        items: [
          { id: 'c1', icon: '🎯', title: 'Innovation & Creativity', description: 'Demonstrates original thinking and creative approaches to teaching' },
          { id: 'c2', icon: '📚', title: 'Content Mastery', description: 'Shows deep understanding of subject matter' },
          { id: 'c3', icon: '👥', title: 'Student Engagement', description: 'Effectively involves students in the learning process' },
          { id: 'c4', icon: '📊', title: 'Measurable Outcomes', description: 'Provides evidence of student learning' },
          { id: 'c5', icon: '🔧', title: 'Practical Application', description: 'Teaching methods are practical and replicable' },
          { id: 'c6', icon: '💡', title: 'Differentiation', description: 'Addresses diverse learning needs' },
          { id: 'c7', icon: '⏱️', title: 'Time Management', description: 'Demonstrates effective use of instructional time' },
          { id: 'c8', icon: '🌟', title: 'Overall Excellence', description: 'Demonstrates overall teaching excellence' },
        ],
      },
    },
    {
      id: 'awards',
      type: 'awards',
      enabled: true,
      order: 4,
      content: {
        title: 'Awards & Recognition',
        subtitle: 'Winners and outstanding participants receive prestigious recognition and valuable rewards for their contributions to education excellence.',
        image: "/Images/landing_page_images/tscs3.jpg",
        imagePosition: 'right',
        items: [
          { id: 'a1', title: 'Gold Award', place: '1st Place', prize: '$5,000', color: 'gold', icon: 'trophy' },
          { id: 'a2', title: 'Silver Award', place: '2nd Place', prize: '$3,000', color: 'silver', icon: 'star' },
          { id: 'a3', title: 'Bronze Award', place: '3rd Place', prize: '$1,500', color: 'bronze', icon: 'gift' },
        ],
      },
    },
    {
      id: 'cta',
      type: 'cta',
      enabled: true,
      order: 5,
      content: {
        title: 'Ready to Showcase Your Excellence?',
        subtitle: 'Join hundreds of educators competing for recognition and awards. Your teaching excellence deserves to be celebrated.',
        backgroundImage: "/Images/landing_page_images/tscs5.jpg",
        primaryButtonText: "Register Now",
        primaryButtonLink: "/register",
        secondaryButtonText: "Login to Your Account",
        secondaryButtonLink: "/login",
      },
    },
  ],
};

async function seedLandingPage() {
  try {
    console.log('🔄 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/tscs');
    console.log('✅ Connected to MongoDB');

    // Check if landing page content already exists
    const existingSections = await LandingPage.countDocuments();
    if (existingSections > 0) {
      console.log(`⚠️  Landing page content already exists (${existingSections} sections found)`);
      console.log('💡 To reset, delete existing sections first or use the reset function in the editor');
      process.exit(0);
    }

    // Seed settings
    console.log('📝 Seeding landing page settings...');
    for (const [key, value] of Object.entries(defaultLandingContent.settings)) {
      await LandingPageSettings.findOneAndUpdate(
        { key },
        { key, value },
        { upsert: true, new: true }
      );
    }
    console.log('✅ Settings seeded successfully');

    // Seed sections
    console.log('📝 Seeding landing page sections...');
    const sections = await LandingPage.insertMany(
      defaultLandingContent.sections.map(section => ({
        id: section.id,
        type: section.type,
        enabled: section.enabled,
        order: section.order,
        content: section.content
      }))
    );

    console.log(`✅ Successfully seeded ${sections.length} landing page sections:`);
    sections.forEach(section => {
      console.log(`   - ${section.type} (${section.id})`);
    });

    console.log('\n✅ Landing page content seeded successfully!');
    console.log('🌐 You can now edit the landing page in the Superadmin panel');

    process.exit(0);
  } catch (error) {
    console.error('❌ Error seeding landing page:', error.message);
    console.error(error);
    process.exit(1);
  }
}

seedLandingPage();

