package fixture.customer;

import java.util.List;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;

public interface CustomerRepository extends JpaRepository<Customer, Long> {
    Customer findByExternalId(String externalId);
    List<Customer> findByStatus(CustomerStatus status);

    @Query("select c from Customer c where lower(c.name) like lower(concat('%', :name, '%'))")
    List<Customer> searchByName(String name);
}
