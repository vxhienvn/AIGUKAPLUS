const { app, startBackgroundJobs } = require('./src/app');
const registerMappingCenter = require('./src/routes/mappingCenterRoutes');

registerMappingCenter(app);

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
    console.log(`Server running on ${PORT}`);
    startBackgroundJobs();
});
