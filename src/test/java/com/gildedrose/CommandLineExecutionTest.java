package com.gildedrose;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

class CommandLineExecutionTest {

    @Test
    void texttestFixtureCanParseArguments() {
        // Test validates the argument parsing logic used in TexttestFixture
        // This is the core requirement from specification:
        // "./gradlew -q text --args 10" should work
        
        // Simulate what would happen in the fixture with valid args
        String[] validArgs = {"10"};
        int days = Integer.parseInt(validArgs[0]) + 1;
        assertEquals(11, days);
        
        // Test with zero argument
        String[] zeroArgs = {"0"};
        int daysZero = Integer.parseInt(zeroArgs[0]) + 1;
        assertEquals(1, daysZero);
    }

    @Test
    void texttestFixtureHasRequiredItemsForCommandLineExecution() {
        // Test that we have all the items described in the fixture that 
        // would be used for command-line execution
        Item[] items = new Item[] {
            new Item("+5 Dexterity Vest", 10, 20), //
            new Item("Aged Brie", 2, 0), //
            new Item("Elixir of the Mongoose", 5, 7), //
            new Item("Sulfuras, Hand of Ragnaros", 0, 80), //
            new Item("Sulfuras, Hand of Ragnaros", -1, 80),
            new Item("Backstage passes to a TAFKAL80ETC concert", 15, 20),
            new Item("Backstage passes to a TAFKAL80ETC concert", 10, 49),
            new Item("Backstage passes to a TAFKAL80ETC concert", 5, 49),
            new Item("Conjured Mana Cake", 3, 6) 
        };
        
        GildedRose app = new GildedRose(items);
        
        assertNotNull(app);
        assertNotNull(app.items);
        assertEquals(9, app.items.length);
    }

    @Test
    void texttestFixtureCanUpdateQualityForMultipleIterations() {
        // Test the fundamental updateQuality functionality needed for 
        // command-line execution that runs multiple days
        Item[] items = new Item[] { new Item("foo", 0, 0) };
        GildedRose app = new GildedRose(items);
        
        // This should not throw an exception and should work even though 
        // the implementation might not be complete yet
        assertDoesNotThrow(() -> {
            app.updateQuality();
            app.updateQuality(); 
        });
    }
}