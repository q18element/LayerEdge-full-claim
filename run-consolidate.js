// Script to run Consolidate workflow
const LayerEdgeAllocationChecker = require('./index.js');

async function runConsolidateWorkflow() {
    console.log('💰 Starting LayerEdge ETH Consolidate Workflow...');
    console.log('='.repeat(50));
    
    const checker = new LayerEdgeAllocationChecker();
    
    // Show initial status
    console.log('Initial Status:', checker.getStatus());
    
    // Start the Consolidate background process
    console.log('\n🚀 Starting Consolidate background process...');
    
    try {
        await checker.runConsolidateBackground();
        console.log('\n✅ Consolidate workflow completed successfully!');
    } catch (error) {
        console.error('\n❌ Consolidate workflow failed:', error.message);
    }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Received SIGINT, shutting down gracefully...');
    process.exit(0);
});

runConsolidateWorkflow().catch(console.error);
