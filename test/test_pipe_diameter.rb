DB_PATH = 'C:\Chaitanya\ExchangeTerminal\Exter\tests\ICMExchange.Tests\Database\TestDatabase_v2026_2.icmm'
db = WSApplication.open(DB_PATH)
model = db.model_object_from_type_and_id('Model network', 2)
network = model.open
pipe = network.row_object('hw_conduit', 'TF91299401.1')
node = network.row_object('hw_node','TF91303402')
all_nodes = network.row_objects('hw_node')