require 'date'
require_relative 'test2'
date = Date.today
puts "Hello, World!"
db = WSApplication.open 'C:\Chaitanya\ExchangeTerminal\Exter\tests\ICMExchange.Tests\Database\TestDatabase_v2026_2.icmm'
mo = db.model_object_from_type_and_id("Model network", 1)
m1 = db.model_object_from_type_and_id("Selection list", 2)
