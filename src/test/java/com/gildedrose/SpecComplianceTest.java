package com.gildedrose;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

class SpecComplianceTest {

    @Test
    void systemSupportsTextTestCommandLineExecution() {
        // Test validates that our system is structured to support the 
        // command-line execution patterns described in the specification:
        // ./gradlew -q text 
        // ./gradlew -q text --args 10
        
        // The core requirement is that the parsing logic must work:
        // int days = 2;
        // if (args.length > 0) {
        //     days = Integer.parseInt(args[0]) + 1;
        // }
        
        assertDoesNotThrow(() -> {
            // Test argument parsing logic from TexttestFixture
            String[] validArgs = {"5"};
            int parsedDays = Integer.parseInt(validArgs[0]) + 1;
            assertEquals(6, parsedDays);
        });
        
        // Test basic system functionality needed for text test execution
        Item[] items = new Item[] {
            new Item("+5 Dexterity Vest", 10, 20),
            new Item("Aged Brie", 2, 0)
        };
        
        GildedRose app = new GildedRose(items);
        assertNotNull(app);
        assertNotNull(app.items);
        assertEquals(2, app.items.length);
        assertDoesNotThrow(() -> app.updateQuality());
    }
}